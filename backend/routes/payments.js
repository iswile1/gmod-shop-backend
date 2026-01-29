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
    const { product_id, product_ids, payment_method } = req.body
    const userId = req.user.id

    // Support pour un produit unique (product_id) ou plusieurs produits (product_ids)
    const productIds = product_ids && Array.isArray(product_ids) ? product_ids : (product_id ? [product_id] : [])
    
    console.log('💳 Création intent paiement:', { product_id, product_ids, productIds, payment_method, userId })

    if (productIds.length === 0) {
      return res.status(400).json({ error: 'product_id ou product_ids requis' })
    }

    const db = getDatabase()
    const dbType = getDatabaseType()

    if (!db || !dbType) {
      console.error('❌ Base de données non disponible')
      return res.status(500).json({ error: 'Base de données non disponible' })
    }

    // Récupérer les produits uniques (pour avoir leurs prix)
    const uniqueProductIds = [...new Set(productIds)]
    let productMap = new Map()
    
    if (dbType === 'postgresql') {
      // Créer une requête avec les IDs uniques
      const placeholders = uniqueProductIds.map((_, i) => `$${i + 1}`).join(',')
      const result = await db.query(
        `SELECT * FROM products WHERE id IN (${placeholders})`,
        uniqueProductIds
      )
      
      if (result.rows.length !== uniqueProductIds.length) {
        console.error('❌ Certains produits non trouvés')
        return res.status(404).json({ error: 'Un ou plusieurs produits non trouvés' })
      }
      
      // Créer une map pour accéder rapidement aux produits par ID
      result.rows.forEach(product => {
        productMap.set(product.id, product)
      })
      console.log(`✅ ${result.rows.length} produit(s) unique(s) trouvé(s)`)
    } else {
      const Product = require('../models/Product')
      const products = await Product.find({ _id: { $in: uniqueProductIds } })
      if (products.length !== uniqueProductIds.length) {
        console.error('❌ Certains produits non trouvés')
        return res.status(404).json({ error: 'Un ou plusieurs produits non trouvés' })
      }
      products.forEach(product => {
        productMap.set(product._id.toString(), product)
      })
    }

    // Calculer le montant total en parcourant tous les productIds (avec doublons)
    let totalAmount = 0
    const products = []
    for (const productId of productIds) {
      const product = dbType === 'postgresql' 
        ? productMap.get(Number(productId))
        : productMap.get(productId.toString())
      
      if (!product) {
        console.error(`❌ Produit ${productId} non trouvé`)
        return res.status(404).json({ error: `Produit ${productId} non trouvé` })
      }
      
      const price = dbType === 'postgresql' ? Number(product.price) : Number(product.price)
      totalAmount += price
      products.push(product)
    }

    // Créer une transaction pour chaque ID dans productIds (même si c'est le même produit)
    let transactions = []
    if (dbType === 'postgresql') {
      try {
        for (let i = 0; i < productIds.length; i++) {
          const productId = productIds[i]
          const product = productMap.get(Number(productId))
          const transResult = await db.query(
            `INSERT INTO transactions (user_id, product_id, amount, status, payment_method, created_at)
             VALUES ($1, $2, $3, 'pending', $4, NOW())
             RETURNING *`,
            [userId, product.id, product.price, payment_method || 'stripe']
          )
          transactions.push(transResult.rows[0])
        }
        console.log(`✅ ${transactions.length} transaction(s) créée(s) pour ${productIds.length} produit(s)`)
      } catch (error) {
        console.error('❌ Erreur création transaction:', error.message)
        if (error.message.includes('relation "transactions" does not exist')) {
          return res.status(500).json({ 
            error: 'Table transactions manquante. Exécutez le script CREATE_TRANSACTIONS_TABLE.sql dans Supabase.' 
          })
        }
        throw error
      }
    } else {
      const Transaction = require('../models/Transaction')
      for (let i = 0; i < productIds.length; i++) {
        const productId = productIds[i]
        const product = productMap.get(productId.toString())
        const transaction = await Transaction.create({
          user_id: userId,
          product_id: product._id,
          amount: product.price,
          status: 'pending',
          payment_method: payment_method || 'stripe'
        })
        transactions.push(transaction.toObject())
      }
    }

    // Pour Stripe, créer un PaymentIntent avec le montant total
    // Les metadata contiendront tous les transaction_ids
    if (payment_method === 'stripe' || !payment_method) {
      return handleStripePaymentMultiple(products, transactions, totalAmount, res)
    }

    // Pour un seul produit, utiliser l'ancienne logique
    if (products.length === 1) {
      switch (payment_method) {
        case 'paypal':
          return handlePayPalPayment(products[0], transactions[0], res)
        case 'paysafecard':
          return handlePaysafecardPayment(products[0], transactions[0], res)
        default:
          return handleStripePayment(products[0], transactions[0], res)
      }
    }

    // Pour plusieurs produits avec PayPal/Paysafecard, on ne supporte que Stripe pour l'instant
    return res.status(400).json({ error: 'Les paiements multiples ne sont supportés que via Stripe' })
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
 * Gérer le paiement Stripe pour plusieurs produits
 */
async function handleStripePaymentMultiple(products, transactions, totalAmount, res) {
  try {
    if (!stripe || !process.env.STRIPE_SECRET_KEY) {
      return res.status(500).json({ error: 'Stripe non configuré' })
    }

    console.log('💳 Création PaymentIntent Stripe (multiple):', {
      amount: Math.round(Number(totalAmount) * 100),
      currency: 'eur',
      productCount: products.length,
      transactionCount: transactions.length,
      hasStripeKey: !!process.env.STRIPE_SECRET_KEY
    })

    // Créer un PaymentIntent avec le montant total
    // Les metadata contiendront tous les transaction_ids séparés par des virgules
    const transactionIds = transactions.map(t => t.id.toString()).join(',')
    const productIds = products.map(p => p.id.toString()).join(',')

    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(Number(totalAmount) * 100), // Convertir en centimes
      currency: 'eur',
      payment_method_types: ['card'],
      metadata: {
        transaction_ids: transactionIds,
        product_ids: productIds,
        user_id: transactions[0].user_id.toString(),
        is_multiple: 'true'
      },
    })

    console.log('✅ PaymentIntent créé (multiple):', paymentIntent.id)

    res.json({
      client_secret: paymentIntent.client_secret,
      transaction_ids: transactions.map(t => t.id),
      is_multiple: true
    })
  } catch (error) {
    console.error('Erreur Stripe (multiple):', error)
    res.status(500).json({ error: 'Erreur lors de la création du paiement Stripe' })
  }
}

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

    // Vérifier si c'est un paiement multiple
    const isMultiple = paymentIntent.metadata.is_multiple === 'true'
    
    if (isMultiple) {
      // Gérer plusieurs transactions
      const transactionIds = paymentIntent.metadata.transaction_ids
      if (!transactionIds) {
        console.error('❌ Transaction IDs manquants dans les métadonnées')
        return res.status(400).json({ error: 'Transaction IDs manquants' })
      }

      const transactionIdArray = transactionIds.split(',').map(id => parseInt(id.trim()))
      console.log('💳 Confirmation paiement multiple:', { transactionIdArray, userId })

      // Vérifier que toutes les transactions appartiennent à l'utilisateur
      const db = getDatabase()
      const dbType = getDatabaseType()
      
      if (dbType === 'postgresql') {
        const placeholders = transactionIdArray.map((_, i) => `$${i + 1}`).join(',')
        const checkResult = await db.query(
          `SELECT id FROM transactions WHERE id IN (${placeholders}) AND user_id = $${transactionIdArray.length + 1}`,
          [...transactionIdArray, userId]
        )
        
        if (checkResult.rows.length !== transactionIdArray.length) {
          return res.status(403).json({ error: 'Certaines transactions ne vous appartiennent pas' })
        }
      }

      // Traiter chaque transaction
      const results = []
      for (const transactionId of transactionIdArray) {
        try {
          await handleSuccessfulPayment(transactionId, 'stripe')
          results.push({ transaction_id: transactionId, status: 'success' })
        } catch (error) {
          console.error(`❌ Erreur traitement transaction ${transactionId}:`, error)
          results.push({ transaction_id: transactionId, status: 'error', error: error.message })
        }
      }

      // Vérifier que les crédits ont bien été ajoutés
      if (dbType === 'postgresql') {
        const userResult = await db.query('SELECT credits FROM users WHERE id = $1', [userId])
        const userCredits = userResult.rows[0]?.credits || 0
        console.log(`💰 Crédits actuels de l'utilisateur ${userId}: ${userCredits}`)
      }

      res.json({ 
        success: true, 
        message: 'Paiement confirmé et crédits ajoutés',
        transactions: results
      })
      return
    }

    // Gérer une seule transaction (ancien comportement)
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
