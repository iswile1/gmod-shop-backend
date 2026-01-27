/**
 * Serveur principal de l'API GMod Shop
 * Gère toutes les routes et la configuration
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const session = require('express-session');
const passport = require('./config/steam');

// Import des routes
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const productRoutes = require('./routes/products');
const paymentRoutes = require('./routes/payments');
const adminRoutes = require('./routes/admin');
const gmodRoutes = require('./routes/gmod');

// Import de la configuration de la base de données
const { connectDatabase } = require('./config/database');

const app = express();
const PORT = process.env.PORT || 3001;

// Trust proxy (nécessaire pour Railway et les headers X-Forwarded-For)
app.set('trust proxy', true);

// Middlewares de sécurité
app.use(helmet());
// Configuration CORS - Accepter toutes les origines (temporaire pour debug)
app.use(cors({
  origin: true, // Accepter toutes les origines
  credentials: true
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limite chaque IP à 100 requêtes par fenêtre
});
app.use('/api/', limiter);

// Logging
if (process.env.NODE_ENV === 'development') {
  app.use(morgan('dev'));
} else {
  app.use(morgan('combined'));
}

// Parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Sessions pour Steam Auth
app.use(session({
  secret: process.env.SESSION_SECRET || 'your-secret-key-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000 // 24 heures
  }
}));

// Passport
app.use(passport.initialize());
app.use(passport.session());

// Routes de santé
app.get('/health', async (req, res) => {
  const { getDatabase, getDatabaseType } = require('./config/database');
  const db = getDatabase();
  const dbType = getDatabaseType();
  let dbStatus = 'disconnected';
  
  if (db && dbType) {
    try {
      if (dbType === 'postgresql') {
        await db.query('SELECT NOW()');
        dbStatus = 'connected';
      } else {
        dbStatus = 'connected';
      }
    } catch (error) {
      dbStatus = 'error: ' + error.message;
    }
  }
  
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    database: {
      type: dbType || 'none',
      status: dbStatus
    }
  });
});

// Routes API
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/products', productRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/gmod', gmodRoutes);

// Gestion des erreurs 404
app.use((req, res) => {
  res.status(404).json({ error: 'Route non trouvée' });
});

// Gestionnaire d'erreurs global
app.use((err, req, res, next) => {
  console.error('Erreur:', err);
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production' 
      ? 'Erreur serveur' 
      : err.message,
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
  });
});

// Démarrage du serveur
async function startServer() {
  try {
    console.log('🔄 Démarrage du serveur...');
    console.log(`📡 Port: ${PORT}`);
    console.log(`🌍 Environnement: ${process.env.NODE_ENV || 'development'}`);
    
    // Connexion à la base de données (optionnelle pour le démarrage)
    const dbConnected = await connectDatabase();
    if (!dbConnected) {
      console.warn('⚠️  Le serveur démarre sans base de données. Certaines fonctionnalités seront limitées.');
    }
    
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`🚀 Serveur démarré sur le port ${PORT}`);
      console.log(`📡 Environnement: ${process.env.NODE_ENV || 'development'}`);
      console.log(`✅ Serveur prêt à recevoir des requêtes`);
    });
  } catch (error) {
    console.error('❌ Erreur au démarrage:', error);
    process.exit(1);
  }
}

startServer();

module.exports = app;
