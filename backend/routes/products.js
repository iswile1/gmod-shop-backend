const express = require('express')
const router = express.Router()
const { getDatabase, getDatabaseType } = require('../config/database')

/**
 * Récupérer tous les produits actifs
 */
router.get('/', async (req, res) => {
  try {
    const db = getDatabase()
    const dbType = getDatabaseType()

    if (!db || !dbType) {
      return res.status(500).json({ error: 'Base de données non disponible' })
    }

    let products = []
    if (dbType === 'postgresql') {
      const result = await db.query(
        'SELECT * FROM products WHERE active = true ORDER BY price ASC'
      )
      products = result.rows
    } else {
      const Product = require('../models/Product')
      products = await Product.find({ active: true }).sort({ price: 1 })
      products = products.map(p => p.toObject())
    }

    res.json({ products })
  } catch (error) {
    console.error('Erreur récupération produits:', error)
    res.status(500).json({ error: 'Erreur lors de la récupération des produits' })
  }
})

/**
 * Récupérer un produit par ID
 */
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params
    const db = getDatabase()
    const dbType = getDatabaseType()

    if (!db || !dbType) {
      return res.status(500).json({ error: 'Base de données non disponible' })
    }

    let product
    if (dbType === 'postgresql') {
      const result = await db.query('SELECT * FROM products WHERE id = $1', [id])
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Produit non trouvé' })
      }
      product = result.rows[0]
    } else {
      const Product = require('../models/Product')
      product = await Product.findById(id)
      if (!product) {
        return res.status(404).json({ error: 'Produit non trouvé' })
      }
      product = product.toObject()
    }

    res.json({ product })
  } catch (error) {
    console.error('Erreur récupération produit:', error)
    res.status(500).json({ error: 'Erreur lors de la récupération du produit' })
  }
})

/**
 * Récupérer les produits par type
 */
router.get('/type/:type', async (req, res) => {
  try {
    const { type } = req.params
    const db = getDatabase()
    const dbType = getDatabaseType()

    if (!db || !dbType) {
      return res.status(500).json({ error: 'Base de données non disponible' })
    }

    // Valider le type
    const validTypes = ['credits', 'weapon_perm', 'skin']
    if (!validTypes.includes(type)) {
      return res.status(400).json({ error: 'Type de produit invalide' })
    }

    let products = []
    if (dbType === 'postgresql') {
      const result = await db.query(
        'SELECT * FROM products WHERE type = $1 AND active = true ORDER BY price ASC',
        [type]
      )
      products = result.rows
    } else {
      const Product = require('../models/Product')
      products = await Product.find({ type, active: true }).sort({ price: 1 })
      products = products.map(p => p.toObject())
    }

    res.json({ products })
  } catch (error) {
    console.error('Erreur récupération produits par type:', error)
    res.status(500).json({ error: 'Erreur lors de la récupération des produits' })
  }
})

module.exports = router
