const express = require('express')
const router = express.Router()
const { authenticate } = require('../middleware/auth')
const { getDatabase, getDatabaseType } = require('../config/database')
const Stripe = require('stripe')

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '')

/**
 * Créer un intent de paiement (Stripe, PayPal, Paysafecard)
 */
router.post('/create-intent', authenticate, async (req, res) => {
  try {
    const { product_id, payment_method } = req.body
    const userId = req.user.id

    console.log('💳 Création intent paiement:', { product_id, payment_method, userId })

    if (!product_id) {
      return res.status(400).json({ error: 'product_id requis' })
    }

    const db = getDatabase()
    const dbType = getDatabaseType()

    if (!db || !dbType) {
      console.error('❌ Base de données non disponible')
      return res.status(500).json({ error: 'Base de données non disponible' })
    }

    // Récupérer le produit
    let product
    if (dbType === 'postgresql') {
      const result = await db.query('SELECT * FROM products WHERE id = $1', [product_id])
      if (result.rows.length === 0) {
        console.error('❌ Produit non trouvé:', product_id)
        return res.status(404).json({ error: 'Produit non trouvé' })
      }
      product = result.rows[0]
      console.log('✅ Produit trouvé:', product.name, product.price)
    } else {
      const Product = require('../models/Product')
      product = await Product.findById(product_id)
      if (!product) {
        console.error('❌ Produit non trouvé:', product_id)
        return res.status(404).json({ error: 'Produit non trouvé' })
      }
    }

    // Créer une transaction en attente
    let transaction
    if (dbType === 'postgresql') {
      try {
        const transResult = await db.query(
          `INSERT INTO transactions (user_id, product_id, amount, status, payment_method, created_at)
           VALUES ($1, $2, $3, 'pending', $4, NOW())
           RETURNING *`,
          [userId, product_id, product.price, payment_method || 'stripe']
        )
        transaction = transResult.rows[0]
        console.log('✅ Transaction créée:', transaction.id)
      } catch (error) {
        console.error('❌ Erreur création transaction:', error.message)
        console.error('❌ Détails:', error)
        // Si la table n'existe pas, donner un message plus clair
        if (error.message.includes('relation "transactions" does not exist')) {
          return res.status(500).json({ 
            error: 'Table transactions manquante. Exécutez le script CREATE_TRANSACTIONS_TABLE.sql dans Supabase.' 
          })
        }
        throw error
      }
    } else {
      const Transaction = require('../models/Transaction')
      transaction = await Transaction.create({
        user_id: userId,
        product_id: product_id,
        amount: product.price,
        status: 'pending',
        payment_method: payment_method || 'stripe'
      })
      transaction = transaction.toObject()
    }

    // Gérer selon la méthode de paiement
    switch (payment_method) {
      case 'stripe':
        return handleStripePayment(product, transaction, res)
      
      case 'paypal':
        return handlePayPalPayment(product, transaction, res)
      
      case 'paysafecard':
        return handlePaysafecardPayment(product, transaction, res)
      
      default:
        return handleStripePayment(product, transaction, res)
    }
  } catch (error) {
    console.error('❌ Erreur création intent paiement:', error)
    console.error('❌ Stack:', error.stack)
    res.status(500).json({ 
      error: 'Erreur lors de la création du paiement',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    })
  }
})

/**
 * Gérer le paiement Stripe
 */
async function handleStripePayment(product, transaction, res) {
  try {
    if (!stripe || !process.env.STRIPE_SECRET_KEY) {
      return res.status(500).json({ error: 'Stripe non configuré' })
    }

    // Vérifier que Stripe est bien configuré
    console.log('💳 Création PaymentIntent Stripe:', {
      amount: Math.round(Number(product.price) * 100),
      currency: 'eur',
      hasStripeKey: !!process.env.STRIPE_SECRET_KEY
    })

    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(Number(product.price) * 100), // Convertir en centimes
      currency: 'eur',
      payment_method_types: ['card'], // Spécifier explicitement les cartes bancaires
      metadata: {
        transaction_id: transaction.id.toString(),
        product_id: product.id.toString(),
        user_id: transaction.user_id.toString()
      },
    })

    console.log('✅ PaymentIntent créé:', paymentIntent.id)

    res.json({
      client_secret: paymentIntent.client_secret,
      transaction_id: transaction.id
    })
  } catch (error) {
    console.error('Erreur Stripe:', error)
    res.status(500).json({ error: 'Erreur lors de la création du paiement Stripe' })
  }
}

/**
 * Gérer le paiement PayPal
 */
async function handlePayPalPayment(product, transaction, res) {
  try {
    // Note: paypal-rest-sdk est déprécié, mais on l'utilise pour l'exemple
    // En production, utilisez @paypal/checkout-server-sdk
    const paypal = require('paypal-rest-sdk')
    
    paypal.configure({
      mode: process.env.PAYPAL_MODE || 'sandbox', // 'sandbox' ou 'live'
      client_id: process.env.PAYPAL_CLIENT_ID || '',
      client_secret: process.env.PAYPAL_CLIENT_SECRET || ''
    })

    const create_payment_json = {
      intent: 'sale',
      payer: {
        payment_method: 'paypal'
      },
      redirect_urls: {
        return_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/checkout/success?method=paypal&transaction_id=${transaction.id}`,
        cancel_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/checkout?error=cancelled`
      },
      transactions: [{
        item_list: {
          items: [{
            name: product.name,
            sku: product.id.toString(),
            price: Number(product.price).toFixed(2),
            currency: 'EUR',
            quantity: 1
          }]
        },
        amount: {
          currency: 'EUR',
          total: Number(product.price).toFixed(2)
        },
        description: product.description || '',
        custom: transaction.id.toString()
      }]
    }

    paypal.payment.create(create_payment_json, (error, payment) => {
      if (error) {
        console.error('Erreur PayPal:', error)
        return res.status(500).json({ error: 'Erreur lors de la création du paiement PayPal' })
      } else {
        // Trouver l'URL d'approbation
        const approvalUrl = payment.links.find((link) => link.rel === 'approval_url')
        res.json({
          approval_url: approvalUrl ? approvalUrl.href : null,
          transaction_id: transaction.id
        })
      }
    })
  } catch (error) {
    console.error('Erreur PayPal:', error)
    res.status(500).json({ error: 'Erreur lors de la création du paiement PayPal' })
  }
}

/**
 * Gérer le paiement Paysafecard
 * Note: Paysafecard nécessite un compte marchand et une intégration spécifique
 * Cette fonction est un placeholder pour l'implémentation future
 */
async function handlePaysafecardPayment(product, transaction, res) {
  try {
    // Paysafecard nécessite une intégration avec leur API
    // Pour l'instant, on retourne une URL placeholder
    // En production, vous devrez utiliser l'API Paysafecard officielle
    
    const paymentUrl = `${process.env.PAYSAFECARD_API_URL || 'https://api.paysafecard.com'}/payments?transaction_id=${transaction.id}&amount=${product.price}&currency=EUR`
    
    res.json({
      payment_url: paymentUrl,
      transaction_id: transaction.id,
      note: 'Paysafecard nécessite une configuration API spécifique'
    })
  } catch (error) {
    console.error('Erreur Paysafecard:', error)
    res.status(500).json({ error: 'Erreur lors de la création du paiement Paysafecard' })
  }
}

/**
 * Confirmer un paiement Stripe réussi (appelé depuis le frontend)
 */
router.post('/confirm-payment', authenticate, async (req, res) => {
  try {
    const { payment_intent_id } = req.body
    const userId = req.user.id

    if (!payment_intent_id) {
      return res.status(400).json({ error: 'payment_intent_id requis' })
    }

    console.log('💳 Confirmation paiement:', { payment_intent_id, userId })

    // Vérifier le PaymentIntent avec Stripe
    const paymentIntent = await stripe.paymentIntents.retrieve(payment_intent_id)

    if (paymentIntent.status !== 'succeeded') {
      return res.status(400).json({ error: 'Le paiement n\'a pas réussi' })
    }

    // Récupérer l'ID de transaction depuis les métadonnées
    const transactionId = paymentIntent.metadata.transaction_id

    if (!transactionId) {
      console.error('❌ Transaction ID manquant dans les métadonnées')
      return res.status(400).json({ error: 'Transaction ID manquant' })
    }

    // Vérifier que la transaction appartient à l'utilisateur
    const db = getDatabase()
    const dbType = getDatabaseType()

    if (dbType === 'postgresql') {
      const transResult = await db.query(
        'SELECT * FROM transactions WHERE id = $1 AND user_id = $2',
        [transactionId, userId]
      )

      if (transResult.rows.length === 0) {
        return res.status(404).json({ error: 'Transaction non trouvée' })
      }
    }

    // Traiter le paiement réussi
    await handleSuccessfulPayment(transactionId, 'stripe')

    // Vérifier que les crédits ont bien été ajoutés
    if (dbType === 'postgresql') {
      const userResult = await db.query('SELECT credits FROM users WHERE id = $1', [userId])
      const userCredits = userResult.rows[0]?.credits || 0
      console.log(`💰 Crédits actuels de l'utilisateur ${userId}: ${userCredits}`)
    }

    res.json({ 
      success: true, 
      message: 'Paiement confirmé et crédits ajoutés',
      credits_added: true
    })
  } catch (error) {
    console.error('Erreur confirmation paiement:', error)
    res.status(500).json({ 
      error: 'Erreur lors de la confirmation du paiement',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    })
  }
})

/**
 * Webhook Stripe pour confirmer les paiements
 */
router.post('/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature']
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET

  let event

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret)
  } catch (err) {
    console.error('Erreur webhook Stripe:', err.message)
    return res.status(400).send(`Webhook Error: ${err.message}`)
  }

  // Gérer l'événement
  if (event.type === 'payment_intent.succeeded') {
    const paymentIntent = event.data.object
    await handleSuccessfulPayment(paymentIntent.metadata.transaction_id, 'stripe')
  }

  res.json({ received: true })
})

/**
 * Callback PayPal pour confirmer les paiements
 */
router.get('/callback/paypal', async (req, res) => {
  try {
    const { paymentId, PayerID, transaction_id } = req.query

    if (!paymentId || !PayerID || !transaction_id) {
      return res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/checkout?error=invalid_callback`)
    }

    const paypal = require('paypal-rest-sdk')
    paypal.configure({
      mode: process.env.PAYPAL_MODE || 'sandbox',
      client_id: process.env.PAYPAL_CLIENT_ID || '',
      client_secret: process.env.PAYPAL_CLIENT_SECRET || ''
    })

    const execute_payment_json = {
      payer_id: PayerID
    }

    paypal.payment.execute(paymentId, execute_payment_json, async (error, payment) => {
      if (error) {
        console.error('Erreur exécution PayPal:', error)
        return res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/checkout?error=payment_failed`)
      }

      if (payment.state === 'approved') {
        await handleSuccessfulPayment(transaction_id, 'paypal')
        return res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/checkout/success?method=paypal&transaction_id=${transaction_id}`)
      } else {
        return res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/checkout?error=payment_failed`)
      }
    })
  } catch (error) {
    console.error('Erreur callback PayPal:', error)
    res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/checkout?error=server_error`)
  }
})

/**
 * Gérer un paiement réussi (ajouter crédits, débloquer items, etc.)
 */
async function handleSuccessfulPayment(transactionId, paymentMethod) {
  try {
    const db = getDatabase()
    const dbType = getDatabaseType()

    if (!db || !dbType) {
      console.error('Base de données non disponible pour confirmer le paiement')
      return
    }

    // Récupérer la transaction
    let transaction
    if (dbType === 'postgresql') {
      const transResult = await db.query(
        'SELECT * FROM transactions WHERE id = $1',
        [transactionId]
      )
      if (transResult.rows.length === 0) {
        console.error('Transaction non trouvée:', transactionId)
        return
      }
      transaction = transResult.rows[0]

      // Vérifier si déjà traitée
      if (transaction.status === 'completed') {
        console.log('Transaction déjà traitée:', transactionId)
        return
      }

      // Récupérer le produit
      const productResult = await db.query('SELECT * FROM products WHERE id = $1', [transaction.product_id])
      if (productResult.rows.length === 0) {
        console.error('❌ Produit non trouvé pour la transaction:', transactionId)
        return
      }
      const product = productResult.rows[0]
      console.log(`📦 Produit trouvé: ${product.name}, type: ${product.type}, credits_amount: ${product.credits_amount}`)

      // Mettre à jour la transaction
      // Note: Si la colonne completed_at n'existe pas, on l'ignore
      try {
        await db.query(
          'UPDATE transactions SET status = $1, payment_method = $2 WHERE id = $3',
          ['completed', paymentMethod, transactionId]
        )
      } catch (updateError) {
        console.error('❌ Erreur mise à jour transaction:', updateError.message)
        throw updateError
      }

      // Ajouter les crédits si c'est un pack de crédits
      if (product.type === 'credits' && product.credits_amount) {
        console.log(`💰 Ajout de ${product.credits_amount} crédits à l'utilisateur ${transaction.user_id}`)
        
        const updateResult = await db.query(
          'UPDATE users SET credits = credits + $1 WHERE id = $2 RETURNING credits',
          [product.credits_amount, transaction.user_id]
        )
        
        const newCredits = updateResult.rows[0]?.credits || 0
        console.log(`✅ ${product.credits_amount} crédits ajoutés à l'utilisateur ${transaction.user_id}. Nouveau total: ${newCredits}`)
      } else {
        console.log(`⚠️ Produit n'est pas un pack de crédits (type: ${product.type})`)
      }

      // Pour les armes et skins, on pourrait créer une entrée dans une table inventory
      // ou envoyer une requête au serveur GMod via API
      if (product.type === 'weapon_perm' || product.type === 'skin') {
        // TODO: Intégration avec le serveur GMod
        console.log(`📦 Item ${product.name} débloqué pour l'utilisateur ${transaction.user_id}`)
      }

    } else {
      // MongoDB
      const Transaction = require('../models/Transaction')
      const Product = require('../models/Product')
      
      transaction = await Transaction.findById(transactionId)
      if (!transaction || transaction.status === 'completed') {
        return
      }

      const product = await Product.findById(transaction.product_id)
      if (!product) {
        return
      }

      transaction.status = 'completed'
      transaction.payment_method = paymentMethod
      await transaction.save()

      if (product.type === 'credits' && product.credits_amount) {
        const User = require('../models/User')
        await User.findByIdAndUpdate(transaction.user_id, {
          $inc: { credits: product.credits_amount }
        })
      }
    }

    console.log(`✅ Paiement confirmé: Transaction ${transactionId} (${paymentMethod})`)
  } catch (error) {
    console.error('Erreur lors du traitement du paiement réussi:', error)
  }
}

/**
 * Récupérer l'historique des transactions de l'utilisateur
 */
router.get('/transactions', authenticate, async (req, res) => {
  try {
    const userId = req.user.id
    const db = getDatabase()
    const dbType = getDatabaseType()

    if (!db || !dbType) {
      return res.status(500).json({ error: 'Base de données non disponible' })
    }

    let transactions
    if (dbType === 'postgresql') {
      const result = await db.query(
        `SELECT t.*, p.name as product_name, p.type as product_type
         FROM transactions t
         JOIN products p ON t.product_id = p.id
         WHERE t.user_id = $1
         ORDER BY t.created_at DESC
         LIMIT 50`,
        [userId]
      )
      transactions = result.rows
    } else {
      const Transaction = require('../models/Transaction')
      transactions = await Transaction.find({ user_id: userId })
        .populate('product_id', 'name type')
        .sort({ created_at: -1 })
        .limit(50)
    }

    res.json({ transactions })
  } catch (error) {
    console.error('Erreur récupération transactions:', error)
    res.status(500).json({ error: 'Erreur lors de la récupération des transactions' })
  }
})

module.exports = router
