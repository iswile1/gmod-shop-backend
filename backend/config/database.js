/**
 * Configuration de la base de données
 * Supporte PostgreSQL et MongoDB
 */

let db = null;
let dbType = null;

// Détection du type de base de données
if (process.env.DATABASE_URL && process.env.DATABASE_URL.startsWith('postgresql://')) {
  // PostgreSQL
  const { Pool } = require('pg');
  dbType = 'postgresql';
  
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 5000, // Timeout de 5 secondes
    idleTimeoutMillis: 30000,
    max: 10 // Nombre max de connexions
  });
  
  db = pool;
  
  // Test de connexion
  pool.on('connect', () => {
    console.log('✅ Connecté à PostgreSQL');
  });
  
  pool.on('error', (err) => {
    console.error('❌ Erreur PostgreSQL:', err);
  });
  
} else if (process.env.MONGODB_URI) {
  // MongoDB
  const mongoose = require('mongoose');
  dbType = 'mongodb';
  db = mongoose;
}

/**
 * Connexion à la base de données
 */
async function connectDatabase() {
  if (dbType === 'postgresql') {
    try {
      // Timeout de 5 secondes pour la connexion
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Timeout de connexion')), 5000)
      );
      
      await Promise.race([
        db.query('SELECT NOW()'),
        timeoutPromise
      ]);
      
      console.log('✅ Base de données PostgreSQL connectée');
      await initPostgreSQLTables();
    } catch (error) {
      console.warn('⚠️  Avertissement: Base de données non accessible:', error.message);
      console.warn('⚠️  Le serveur démarre quand même, mais certaines fonctionnalités ne fonctionneront pas.');
      // Ne pas throw l'erreur, permettre au serveur de démarrer
      return false;
    }
  } else if (dbType === 'mongodb') {
    try {
      await mongoose.connect(process.env.MONGODB_URI, {
        serverSelectionTimeoutMS: 5000
      });
      console.log('✅ Base de données MongoDB connectée');
    } catch (error) {
      console.warn('⚠️  Avertissement: Base de données non accessible:', error.message);
      console.warn('⚠️  Le serveur démarre quand même, mais certaines fonctionnalités ne fonctionneront pas.');
      // Ne pas throw l'erreur, permettre au serveur de démarrer
      return false;
    }
  } else {
    console.warn('⚠️  Aucune base de données configurée');
  }
  return true;
}

/**
 * Initialisation des tables PostgreSQL
 */
async function initPostgreSQLTables() {
  if (dbType !== 'postgresql') return;
  
  const queries = [
    // Table des utilisateurs
    `CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      steam_id VARCHAR(255) UNIQUE,
      username VARCHAR(255) NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      credits INTEGER DEFAULT 0,
      role VARCHAR(50) DEFAULT 'user',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    
    // Table des produits
    `CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      description TEXT,
      type VARCHAR(50) NOT NULL,
      price DECIMAL(10, 2) NOT NULL,
      credits_amount INTEGER,
      item_data JSONB,
      image_url VARCHAR(500),
      active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    
    // Table des transactions
    `CREATE TABLE IF NOT EXISTS transactions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      product_id INTEGER REFERENCES products(id),
      amount DECIMAL(10, 2) NOT NULL,
      payment_method VARCHAR(50) NOT NULL,
      payment_id VARCHAR(255),
      status VARCHAR(50) DEFAULT 'pending',
      credits_added INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    
    // Table des items possédés
    `CREATE TABLE IF NOT EXISTS user_items (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      product_id INTEGER REFERENCES products(id),
      item_type VARCHAR(50) NOT NULL,
      item_data JSONB,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    
    // Index pour améliorer les performances
    `CREATE INDEX IF NOT EXISTS idx_users_steam_id ON users(steam_id)`,
    `CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`,
    `CREATE INDEX IF NOT EXISTS idx_transactions_user_id ON transactions(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status)`,
    `CREATE INDEX IF NOT EXISTS idx_user_items_user_id ON user_items(user_id)`
  ];
  
  for (const query of queries) {
    try {
      await db.query(query);
    } catch (error) {
      console.error('Erreur lors de la création de table:', error);
    }
  }
  
  console.log('✅ Tables PostgreSQL initialisées');
}

/**
 * Obtenir l'instance de la base de données
 */
function getDatabase() {
  return db;
}

/**
 * Obtenir le type de base de données
 */
function getDatabaseType() {
  return dbType;
}

module.exports = {
  connectDatabase,
  getDatabase,
  getDatabaseType,
  initPostgreSQLTables
};
