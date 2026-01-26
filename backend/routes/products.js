/**
 * Routes pour les produits
 * Liste, détails, achat de produits
 */

const express = require('express');
const { getDatabase, getDatabaseType } = require('../config/database');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

/**
 * GET /api/products
 * Liste tous les produits actifs
 */
router.get('/', async (req, res) => {
  try {
    const db = getDatabase();
    const dbType = getDatabaseType();
    
    let products;
    if (dbType === 'postgresql') {
      const result = await db.query(
        'SELECT id, name, description, type, price, credits_amount, item_data, image_url FROM products WHERE active = true ORDER BY type, price'
      );
      products = result.rows;
    } else if (dbType === 'mongodb') {
      const Product = require('../models/Product');
      products = await Product.find({ active: true }).select('-__v');
    }
    
    res.json({ products });
  } catch (error) {
    console.error('Erreur récupération produits:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/**
 * GET /api/products/:id
 * Détails d'un produit
 */
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const db = getDatabase();
    const dbType = getDatabaseType();
    
    let product;
    if (dbType === 'postgresql') {
      const result = await db.query(
        'SELECT id, name, description, type, price, credits_amount, item_data, image_url FROM products WHERE id = $1 AND active = true',
        [id]
      );
      product = result.rows[0];
    } else if (dbType === 'mongodb') {
      const Product = require('../models/Product');
      product = await Product.findOne({ _id: id, active: true }).select('-__v');
    }
    
    if (!product) {
      return res.status(404).json({ error: 'Produit non trouvé' });
    }
    
    res.json({ product });
  } catch (error) {
    console.error('Erreur récupération produit:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/**
 * GET /api/products/type/:type
 * Liste les produits par type (credits, weapon_perm, skin)
 */
router.get('/type/:type', async (req, res) => {
  try {
    const { type } = req.params;
    const validTypes = ['credits', 'weapon_perm', 'skin'];
    
    if (!validTypes.includes(type)) {
      return res.status(400).json({ error: 'Type de produit invalide' });
    }
    
    const db = getDatabase();
    const dbType = getDatabaseType();
    
    let products;
    if (dbType === 'postgresql') {
      const result = await db.query(
        'SELECT id, name, description, type, price, credits_amount, item_data, image_url FROM products WHERE type = $1 AND active = true ORDER BY price',
        [type]
      );
      products = result.rows;
    } else if (dbType === 'mongodb') {
      const Product = require('../models/Product');
      products = await Product.find({ type, active: true }).select('-__v').sort({ price: 1 });
    }
    
    res.json({ products });
  } catch (error) {
    console.error('Erreur récupération produits par type:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
