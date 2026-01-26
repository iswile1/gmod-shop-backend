/**
 * Configuration Steam OpenID
 * Authentification via Steam
 */

const passport = require('passport');
const SteamStrategy = require('passport-steam').Strategy;

// Configuration Steam
const STEAM_API_KEY = process.env.STEAM_API_KEY || '';
const STEAM_REALM = process.env.STEAM_REALM || process.env.FRONTEND_URL || 'http://localhost:3000';
const STEAM_RETURN_URL = process.env.STEAM_RETURN_URL || `${STEAM_REALM}/api/auth/steam/return`;

// Configuration de la stratégie Steam
passport.use(new SteamStrategy({
    returnURL: STEAM_RETURN_URL,
    realm: STEAM_REALM,
    apiKey: STEAM_API_KEY
  },
  async (identifier, profile, done) => {
    try {
      // Le profile contient les informations Steam
      // identifier est l'URL Steam OpenID qui se termine par le Steam ID
      // profile contient steamid, displayName, etc.
      
      // Extraire le Steam ID depuis l'identifier (format: https://steamcommunity.com/openid/id/7656119...)
      const steamId = identifier.split('/').pop() || profile.steamid;
      
      return done(null, {
        steamId: steamId,
        username: profile.displayName || profile.username || `Steam_${steamId}`,
        avatar: profile.photos?.[0]?.value || null,
        profileUrl: profile._json?.profileurl || null
      });
    } catch (error) {
      console.error('Erreur Steam auth:', error);
      return done(error, null);
    }
  }
));

// Sérialisation de l'utilisateur pour la session
passport.serializeUser((user, done) => {
  done(null, user);
});

passport.deserializeUser((user, done) => {
  done(null, user);
});

module.exports = passport;
