/**
 * Routes d'administration
 * Gestion des produits, utilisateurs, crédits
 */

const express = require('express');
const { body, validationResult } = require('express-validator');
const { getDatabase, getDatabaseType } = require('../config/database');
const { authenticate, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// Toutes les routes admin nécessitent l'authentification et le rôle admin
router.use(authenticate);
router.use(requireAdmin);

/**
 * GET /api/admin/products
 * Liste tous les produits (y compris inactifs)
 */
router.get('/products', async (req, res) => {
  try {
    const db = getDatabase();
    const dbType = getDatabaseType();
    
    let products;
    if (dbType === 'postgresql') {
      const result = await db.query('SELECT * FROM products ORDER BY created_at DESC');
      products = result.rows;
    } else if (dbType === 'mongodb') {
      const Product = require('../models/Product');
      products = await Product.find().sort({ createdAt: -1 });
    }
    
    res.json({ products });
  } catch (error) {
    console.error('Erreur récupération produits admin:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/**
 * POST /api/admin/products
 * Crée un nouveau produit
 */
router.post('/products', [
  body('name').trim().notEmpty(),
  body('type').isIn(['credits', 'weapon_perm', 'skin']),
  body('price').isFloat({ min: 0 }),
  body('description').optional().isString()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    
    const { name, description, type, price, credits_amount, item_data, image_url, active } = req.body;
    const db = getDatabase();
    const dbType = getDatabaseType();
    
    let product;
    if (dbType === 'postgresql') {
      const result = await db.query(
        `INSERT INTO products (name, description, type, price, credits_amount, item_data, image_url, active) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) 
         RETURNING *`,
        [name, description || '', type, price, credits_amount || 0, JSON.stringify(item_data || {}), image_url || '', active !== false]
      );
      product = result.rows[0];
    } else if (dbType === 'mongodb') {
      const Product = require('../models/Product');
      product = await Product.create({
        name,
        description: description || '',
        type,
        price,
        credits_amount: credits_amount || 0,
        item_data: item_data || {},
        image_url: image_url || '',
        active: active !== false
      });
    }
    
    res.status(201).json({ product, message: 'Produit créé avec succès' });
  } catch (error) {
    console.error('Erreur création produit:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/**
 * PUT /api/admin/products/:id
 * Modifie un produit
 */
router.put('/products/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, type, price, credits_amount, item_data, image_url, active } = req.body;
    const db = getDatabase();
    const dbType = getDatabaseType();
    
    let product;
    if (dbType === 'postgresql') {
      const result = await db.query(
        `UPDATE products 
         SET name = $1, description = $2, type = $3, price = $4, credits_amount = $5, 
             item_data = $6, image_url = $7, active = $8, updated_at = CURRENT_TIMESTAMP 
         WHERE id = $9 
         RETURNING *`,
        [name, description, type, price, credits_amount, JSON.stringify(item_data || {}), image_url, active, id]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Produit non trouvé' });
      }
      product = result.rows[0];
    } else if (dbType === 'mongodb') {
      const Product = require('../models/Product');
      product = await Product.findByIdAndUpdate(
        id,
        {
          name, description, type, price, credits_amount,
          item_data: item_data || {}, image_url, active
        },
        { new: true }
      );
      if (!product) {
        return res.status(404).json({ error: 'Produit non trouvé' });
      }
    }
    
    res.json({ product, message: 'Produit modifié avec succès' });
  } catch (error) {
    console.error('Erreur modification produit:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/**
 * DELETE /api/admin/products/:id
 * Supprime un produit
 */
router.delete('/products/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const db = getDatabase();
    const dbType = getDatabaseType();
    
    if (dbType === 'postgresql') {
      const result = await db.query('DELETE FROM products WHERE id = $1 RETURNING id', [id]);
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Produit non trouvé' });
      }
    } else if (dbType === 'mongodb') {
      const Product = require('../models/Product');
      const product = await Product.findByIdAndDelete(id);
      if (!product) {
        return res.status(404).json({ error: 'Produit non trouvé' });
      }
    }
    
    res.json({ message: 'Produit supprimé avec succès' });
  } catch (error) {
    console.error('Erreur suppression produit:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/**
 * GET /api/admin/users
 * Liste tous les utilisateurs
 */
router.get('/users', async (req, res) => {
  try {
    const db = getDatabase();
    const dbType = getDatabaseType();
    
    let users;
    if (dbType === 'postgresql') {
      const result = await db.query(
        'SELECT id, username, email, credits, role, steam_id, created_at FROM users ORDER BY created_at DESC'
      );
      users = result.rows;
    } else if (dbType === 'mongodb') {
      const User = require('../models/User');
      users = await User.find().select('-password_hash').sort({ createdAt: -1 });
    }
    
    res.json({ users });
  } catch (error) {
    console.error('Erreur récupération utilisateurs:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/**
 * PUT /api/admin/users/:id/credits
 * Modifie les crédits d'un utilisateur
 */
router.put('/users/:id/credits', [
  body('credits').isInt()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    
    const { id } = req.params;
    const { credits } = req.body;
    const db = getDatabase();
    const dbType = getDatabaseType();
    
    let user;
    if (dbType === 'postgresql') {
      const result = await db.query(
        'UPDATE users SET credits = $1 WHERE id = $2 RETURNING id, username, email, credits',
        [credits, id]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Utilisateur non trouvé' });
      }
      user = result.rows[0];
    } else if (dbType === 'mongodb') {
      const User = require('../models/User');
      user = await User.findByIdAndUpdate(id, { credits }, { new: true }).select('-password_hash');
      if (!user) {
        return res.status(404).json({ error: 'Utilisateur non trouvé' });
      }
    }
    
    res.json({ user, message: 'Crédits modifiés avec succès' });
  } catch (error) {
    console.error('Erreur modification crédits:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/**
 * GET /api/admin/transactions
 * Liste toutes les transactions
 */
router.get('/transactions', async (req, res) => {
  try {
    const db = getDatabase();
    const dbType = getDatabaseType();
    
    let transactions;
    if (dbType === 'postgresql') {
      const result = await db.query(
        `SELECT t.*, u.username, u.email, p.name as product_name 
         FROM transactions t 
         JOIN users u ON t.user_id = u.id 
         JOIN products p ON t.product_id = p.id 
         ORDER BY t.created_at DESC 
         LIMIT 100`
      );
      transactions = result.rows;
    } else if (dbType === 'mongodb') {
      const Transaction = require('../models/Transaction');
      transactions = await Transaction.find()
        .populate('user_id', 'username email')
        .populate('product_id', 'name')
        .sort({ created_at: -1 })
        .limit(100);
    }
    
    res.json({ transactions });
  } catch (error) {
    console.error('Erreur récupération transactions admin:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
