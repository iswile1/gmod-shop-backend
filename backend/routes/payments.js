/**
 * Routes pour les paiements
 * Stripe, PayPal, paysafecard
 */

const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { getDatabase, getDatabaseType } = require('../config/database');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

/**
 * POST /api/payments/create-intent
 * Crée une intention de paiement Stripe
 */
router.post('/create-intent', authenticate, async (req, res) => {
  try {
    const { product_id, payment_method } = req.body;
    
    if (!product_id) {
      return res.status(400).json({ error: 'Produit requis' });
    }
    
    const db = getDatabase();
    const dbType = getDatabaseType();
    
    // Récupérer le produit
    let product;
    if (dbType === 'postgresql') {
      const result = await db.query('SELECT * FROM products WHERE id = $1 AND active = true', [product_id]);
      product = result.rows[0];
    } else if (dbType === 'mongodb') {
      const Product = require('../models/Product');
      product = await Product.findById(product_id);
    }
    
    if (!product) {
      return res.status(404).json({ error: 'Produit non trouvé' });
    }
    
    // Créer l'intention de paiement Stripe
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(product.price * 100), // Convertir en centimes
      currency: 'eur',
      metadata: {
        user_id: req.user.id,
        product_id: product_id,
        product_type: product.type,
        credits_amount: product.credits_amount || 0
      }
    });
    
    // Créer une transaction en attente
    if (dbType === 'postgresql') {
      await db.query(
        'INSERT INTO transactions (user_id, product_id, amount, payment_method, payment_id, status) VALUES ($1, $2, $3, $4, $5, $6)',
        [req.user.id, product_id, product.price, payment_method || 'stripe', paymentIntent.id, 'pending']
      );
    } else if (dbType === 'mongodb') {
      const Transaction = require('../models/Transaction');
      await Transaction.create({
        user_id: req.user.id,
        product_id: product_id,
        amount: product.price,
        payment_method: payment_method || 'stripe',
        payment_id: paymentIntent.id,
        status: 'pending'
      });
    }
    
    res.json({
      client_secret: paymentIntent.client_secret,
      payment_intent_id: paymentIntent.id
    });
  } catch (error) {
    console.error('Erreur création paiement:', error);
    res.status(500).json({ error: 'Erreur lors de la création du paiement' });
  }
});

/**
 * POST /api/payments/webhook/stripe
 * Webhook Stripe pour confirmer les paiements
 */
router.post('/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Erreur webhook Stripe:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  
  // Gérer l'événement
  if (event.type === 'payment_intent.succeeded') {
    const paymentIntent = event.data.object;
    await handleSuccessfulPayment(paymentIntent);
  }
  
  res.json({ received: true });
});

/**
 * Gère un paiement réussi
 */
async function handleSuccessfulPayment(paymentIntent) {
  try {
    const { user_id, product_id, product_type, credits_amount } = paymentIntent.metadata;
    const db = getDatabase();
    const dbType = getDatabaseType();
    
    // Mettre à jour la transaction
    if (dbType === 'postgresql') {
      await db.query(
        'UPDATE transactions SET status = $1, credits_added = $2 WHERE payment_id = $3',
        ['completed', credits_amount, paymentIntent.id]
      );
      
      // Ajouter les crédits à l'utilisateur
      if (credits_amount > 0) {
        await db.query('UPDATE users SET credits = credits + $1 WHERE id = $2', [credits_amount, user_id]);
      }
      
      // Si c'est un item (arme perm ou skin), l'ajouter à l'inventaire
      if (product_type === 'weapon_perm' || product_type === 'skin') {
        const productResult = await db.query('SELECT item_data FROM products WHERE id = $1', [product_id]);
        if (productResult.rows.length > 0) {
          await db.query(
            'INSERT INTO user_items (user_id, product_id, item_type, item_data) VALUES ($1, $2, $3, $4)',
            [user_id, product_id, product_type, JSON.stringify(productResult.rows[0].item_data)]
          );
        }
      }
    } else if (dbType === 'mongodb') {
      const Transaction = require('../models/Transaction');
      const User = require('../models/User');
      const Product = require('../models/Product');
      const UserItem = require('../models/UserItem');
      
      await Transaction.findOneAndUpdate(
        { payment_id: paymentIntent.id },
        { status: 'completed', credits_added: credits_amount }
      );
      
      if (credits_amount > 0) {
        await User.findByIdAndUpdate(user_id, { $inc: { credits: credits_amount } });
      }
      
      if (product_type === 'weapon_perm' || product_type === 'skin') {
        const product = await Product.findById(product_id);
        if (product) {
          await UserItem.create({
            user_id: user_id,
            product_id: product_id,
            item_type: product_type,
            item_data: product.item_data
          });
        }
      }
    }
    
    // Notifier le serveur GMod (optionnel)
    // await notifyGModServer(user_id, product_type, credits_amount);
    
    console.log(`✅ Paiement réussi pour l'utilisateur ${user_id}`);
  } catch (error) {
    console.error('Erreur traitement paiement:', error);
  }
}

/**
 * GET /api/payments/transactions
 * Historique des transactions de l'utilisateur
 */
router.get('/transactions', authenticate, async (req, res) => {
  try {
    const db = getDatabase();
    const dbType = getDatabaseType();
    
    let transactions;
    if (dbType === 'postgresql') {
      const result = await db.query(
        `SELECT t.*, p.name as product_name, p.type as product_type 
         FROM transactions t 
         JOIN products p ON t.product_id = p.id 
         WHERE t.user_id = $1 
         ORDER BY t.created_at DESC 
         LIMIT 50`,
        [req.user.id]
      );
      transactions = result.rows;
    } else if (dbType === 'mongodb') {
      const Transaction = require('../models/Transaction');
      transactions = await Transaction.find({ user_id: req.user.id })
        .populate('product_id', 'name type')
        .sort({ created_at: -1 })
        .limit(50);
    }
    
    res.json({ transactions });
  } catch (error) {
    console.error('Erreur récupération transactions:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
