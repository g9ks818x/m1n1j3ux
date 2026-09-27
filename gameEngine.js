'use strict';

/**
 * gameEngine.js
 * -------------
 * Contient TOUT le "moteur" du bot de mini-jeux :
 *  - Le stockage persistant des points/reglages (JSON, ecriture atomique -> compatible Railway Volume)
 *  - Les banques de contenu des 5 mini-jeux (nombre, calcul, mot, devinette, emoji)
 *  - La generation des images (cartes HAVRE MINI JEUX) avec canvas
 *  - Le RoundManager qui gere le cycle de vie d'une manche (lancement, ecoute des reponses,
 *    attribution des points, boucle automatique)
 */

const fs = require('fs');
const path = require('path');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const {
  AttachmentBuilder,
  ContainerBuilder,
  TextDisplayBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
} = require('discord.js');

/**
 * Toute l'UI du bot utilise les Components V2 de Discord (pas d'embeds classiques),
 * pour eviter la barre coloree que Discord affiche sur le cote des embeds.
 * Ce petit helper construit un message "carte de texte" neutre (sans accentColor).
 */
function textCard(content) {
  return new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent(content));
}

function v2Payload(components, { ephemeral = false } = {}) {
  return {
    components: Array.isArray(components) ? components : [components],
    flags: ephemeral ? MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral : MessageFlags.IsComponentsV2,
  };
}

// ============================================================================
// 1) STOCKAGE PERSISTANT (points.json / reglages.json regroupes dans store.json)
// ============================================================================

const DATA_DIR = process.env.DATA_DIR && process.env.DATA_DIR.trim()
  ? process.env.DATA_DIR.trim()
  : path.join(__dirname, 'data');

const STORE_PATH = path.join(DATA_DIR, 'store.json');

const DEFAULT_STORE = {
  points: {}, // { userId: { points: number, wins: number, username: string } }
  settings: {
    channelId: null,
    intervalSeconds: 60,
    pointsPerWin: 5,
    autoRunning: false,
    enabledGames: [
      'number', 'math', 'word', 'riddle', 'emoji',
      'trivia', 'capital', 'sequence', 'synonym', 'antonym', 'truefalse',
    ],
  },
};

// Intervalle minimum autorise entre deux manches automatiques (en secondes).
// En dessous, on risque de spammer le salon / de chevaucher les manches.
const MIN_INTERVAL_SECONDS = 5;
const MAX_INTERVAL_SECONDS = 86400; // 24h

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadStore() {
  ensureDataDir();
  if (!fs.existsSync(STORE_PATH)) {
    saveStore(DEFAULT_STORE);
    return JSON.parse(JSON.stringify(DEFAULT_STORE));
  }
  try {
    const raw = fs.readFileSync(STORE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    // fusion avec les valeurs par defaut au cas ou de nouveaux champs soient ajoutes plus tard
    const settings = { ...DEFAULT_STORE.settings, ...(parsed.settings || {}) };
    // Migration : les anciens stores utilisaient un intervalle en minutes.
    if (parsed.settings && parsed.settings.intervalMinutes && !parsed.settings.intervalSeconds) {
      settings.intervalSeconds = parsed.settings.intervalMinutes * 60;
    }
    delete settings.intervalMinutes;
    return {
      points: parsed.points || {},
      settings,
    };
  } catch (err) {
    console.error('[store] Fichier corrompu, reinitialisation.', err);
    saveStore(DEFAULT_STORE);
    return JSON.parse(JSON.stringify(DEFAULT_STORE));
  }
}

function saveStore(store) {
  ensureDataDir();
  const tmpPath = STORE_PATH + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(store, null, 2), 'utf8');
  fs.renameSync(tmpPath, STORE_PATH); // ecriture atomique : evite un fichier corrompu si le process crash
}

class Store {
  constructor() {
    this.data = loadStore();
  }

  persist() {
    saveStore(this.data);
  }

  getSettings() {
    return this.data.settings;
  }

  updateSettings(partial) {
    this.data.settings = { ...this.data.settings, ...partial };
    this.persist();
    return this.data.settings;
  }

  getUser(userId) {
    return this.data.points[userId] || { points: 0, wins: 0, username: 'Inconnu' };
  }

  addPoints(userId, username, amount) {
    const current = this.data.points[userId] || { points: 0, wins: 0, username };
    current.points += amount;
    current.wins += 1;
    current.username = username;
    this.data.points[userId] = current;
    this.persist();
    return current;
  }

  getLeaderboard(limit = 10) {
    return Object.entries(this.data.points)
      .map(([userId, v]) => ({ userId, ...v }))
      .sort((a, b) => b.points - a.points)
      .slice(0, limit);
  }

  resetPoints() {
    this.data.points = {};
    this.persist();
  }
}

// ============================================================================
// 2) BANQUES DE CONTENU
// ============================================================================

const CARD_COLORS = ['silver', 'blue', 'purple', 'green', 'red', 'gold'];

const COLOR_THEME = {
  silver: { text: '#eef2f6', accent: '#c7d2db', glow: 'rgba(200,210,225,0.6)' },
  blue: { text: '#cfeeff', accent: '#5cc2ff', glow: 'rgba(70,180,255,0.6)' },
  purple: { text: '#ecdfff', accent: '#c19bff', glow: 'rgba(160,110,255,0.6)' },
  green: { text: '#d3ffea', accent: '#57e8ac', glow: 'rgba(60,225,160,0.6)' },
  red: { text: '#ffdbe4', accent: '#ff6b85', glow: 'rgba(255,70,110,0.6)' },
  gold: { text: '#fff2cf', accent: '#ffcf55', glow: 'rgba(255,205,70,0.6)' },
};

const GAME_TYPES = {
  number: { key: 'number', label: 'Devine le Nombre', emoji: '🔢' },
  math: { key: 'math', label: 'Calcul Eclair', emoji: '➗' },
  word: { key: 'word', label: 'Mot Melange', emoji: '🔤' },
  riddle: { key: 'riddle', label: 'Devinette', emoji: '❓' },
  emoji: { key: 'emoji', label: 'Emoji Quiz', emoji: '🎭' },
  trivia: { key: 'trivia', label: 'Culture Generale', emoji: '🧠' },
  capital: { key: 'capital', label: 'Capitale du Monde', emoji: '🌍' },
  sequence: { key: 'sequence', label: 'Suite Logique', emoji: '🔁' },
  synonym: { key: 'synonym', label: 'Trouve le Synonyme', emoji: '📖' },
  antonym: { key: 'antonym', label: 'Trouve le Contraire', emoji: '↔️' },
  truefalse: { key: 'truefalse', label: 'Vrai ou Faux', emoji: '✅' },
};

const WORD_BANK = [
  'ORDINATEUR', 'MANETTE', 'VICTOIRE', 'AVENTURE', 'STRATEGIE', 'PERSONNAGE',
  'BOUCLIER', 'CHEVALIER', 'DRAGON', 'TRESOR', 'ROYAUME', 'EPEE', 'POTION',
  'SORCIER', 'GUERRIER', 'ARENE', 'TOURNOI', 'CHAMPION', 'LEGENDE', 'PORTAIL',
  'LABYRINTHE', 'GALAXIE', 'PLANETE', 'ROBOT', 'FUSEE', 'PIRATE', 'BOUSSOLE',
  'CAPITAINE', 'EQUIPAGE', 'FORTERESSE', 'DONJON', 'MONSTRE', 'ENIGME',
  'CRISTAL', 'AMULETTE', 'PHENIX', 'GRIFFON', 'SIRENE', 'ORACLE', 'EMPIRE',
  'ALLIANCE', 'GUILDE', 'ARMURE', 'CASQUE', 'GRIMOIRE', 'ELIXIR', 'TALISMAN',
  'RELIQUE', 'ARTEFACT', 'CATAPULTE', 'SENTINELLE', 'GARDIEN', 'TEMPLE',
  'VOLCAN', 'GLACIER', 'TEMPETE', 'ECLAIR', 'TONNERRE', 'COMETE', 'MIRAGE',
  'FANTOME', 'VAMPIRE', 'ZOMBIE', 'PALADIN', 'DRUIDE', 'BARDE', 'ASSASSIN',
  'ARCHER', 'ALCHIMISTE', 'FORGERON', 'EXPLORATEUR', 'VOYAGEUR',
];

const RIDDLE_BANK = [
  { q: "Je vole sans ailes et je pleure sans yeux. Que suis-je ?", a: 'nuage' },
  { q: "Plus on m'enleve, plus je grandis. Que suis-je ?", a: 'trou' },
  { q: "J'ai des dents mais je ne mords jamais. Que suis-je ?", a: 'peigne' },
  { q: "Je n'ai ni bouche ni oreilles, pourtant je raconte des histoires. Que suis-je ?", a: 'livre' },
  { q: "Plus je suis grand, moins je pese. Que suis-je ?", a: 'ballon' },
  { q: "On me lance mais je reviens toujours. Que suis-je ?", a: 'boomerang' },
  { q: "Je n'ai pas de vie mais je peux mourir. Que suis-je ?", a: 'batterie' },
  { q: "J'ai une couronne mais je ne suis pas un roi. Que suis-je ?", a: 'dent' },
  { q: "Je suis toujours devant toi mais tu ne peux jamais m'atteindre. Que suis-je ?", a: 'avenir' },
  { q: "Je grandis quand je mange, je meurs quand je bois. Que suis-je ?", a: 'feu' },
  { q: "On me brise sans jamais me toucher. Que suis-je ?", a: 'silence' },
  { q: "J'ai des cles mais je n'ouvre aucune porte. Que suis-je ?", a: 'piano' },
  { q: "Plus il y en a, moins on y voit. Que suis-je ?", a: 'brouillard' },
  { q: "Je voyage autour du monde en restant toujours dans le meme coin. Que suis-je ?", a: 'timbre' },
  { q: "On me trouve une fois dans une minute, deux fois dans un moment, mais jamais dans mille ans. Que suis-je ?", a: 'lettre m' },
  { q: "Je suis rempli de trous mais je retiens l'eau. Que suis-je ?", a: 'eponge' },
  { q: "Je n'ai pas de corps mais je grandis, pas de poumons mais j'ai besoin d'air. Que suis-je ?", a: 'feu' },
  { q: "Plus tu en prends, plus tu en laisses derriere toi. Que suis-je ?", a: 'pas' },
  { q: "Je suis toujours devant vous mais invisible. Le temps passe et je ne bouge pas. Que suis-je ?", a: 'futur' },
  { q: "Je tombe souvent mais je ne me blesse jamais. Que suis-je ?", a: 'pluie' },
  { q: "Je peux traverser le verre sans le casser. Que suis-je ?", a: 'lumiere' },
  { q: "J'ai un lit mais je ne dors jamais. Que suis-je ?", a: 'riviere' },
  { q: "Je suis noir quand je suis propre et blanc quand je suis sale. Que suis-je ?", a: 'tableau' },
  { q: "Je n'ai qu'un oeil mais je ne vois rien. Que suis-je ?", a: 'aiguille' },
];

const EMOJI_BANK = [
  { emojis: '🦁 👑', answer: 'roi lion' },
  { emojis: '🕷️ 👨', answer: 'spiderman' },
  { emojis: '🧊 👸', answer: 'reine des neiges' },
  { emojis: '🏴‍☠️ 🦜', answer: 'pirate' },
  { emojis: '🌊 🍊', answer: 'sponge bob' },
  { emojis: '🦖 🏝️', answer: 'jurassic park' },
  { emojis: '👻 🚫', answer: 'ghostbusters' },
  { emojis: '🐜 🦸', answer: 'ant man' },
  { emojis: '🦇 👨', answer: 'batman' },
  { emojis: '❄️ ⛄', answer: 'la reine des neiges' },
  { emojis: '🐟 🔍', answer: 'nemo' },
  { emojis: '🚀 👨‍🚀', answer: 'astronaute' },
  { emojis: '🍕 🐢', answer: 'tortues ninja' },
  { emojis: '⚡ 👦 🧙', answer: 'harry potter' },
  { emojis: '💍 🌋', answer: 'seigneur des anneaux' },
  { emojis: '🐉 🎮', answer: 'dragon' },
  { emojis: '🏰 👸 🐸', answer: 'la princesse et la grenouille' },
  { emojis: '🎃 👦', answer: 'halloween' },
  { emojis: '🧟 🚶', answer: 'walking dead' },
  { emojis: '🦸‍♂️ 🕸️', answer: 'spiderman' },
  { emojis: '🐭 🏰 ✨', answer: 'disneyland' },
  { emojis: '⚔️ 🛡️ 🏰', answer: 'chevalier' },
  { emojis: '🌕 🐺', answer: 'loup garou' },
  { emojis: '🎮 🕹️', answer: 'jeu video' },
];

const TRIVIA_BANK = [
  { q: "Quel est le plus grand ocean du monde ?", a: 'pacifique' },
  { q: "Quelle planete est surnommee la planete rouge ?", a: 'mars' },
  { q: "Combien de jours y a-t-il dans une annee bissextile ?", a: '366' },
  { q: "Quel est le plus grand mammifere du monde ?", a: 'baleine' },
  { q: "Dans quel pays se trouve la tour Eiffel ?", a: 'france' },
  { q: "Quel est le symbole chimique de l'or ?", a: 'au' },
  { q: "Combien de dents a un adulte humain en moyenne ?", a: '32' },
  { q: "Quel est l'organe le plus grand du corps humain ?", a: 'peau' },
  { q: "Quelle est la monnaie du Japon ?", a: 'yen' },
  { q: "Quel animal est surnomme le roi de la jungle ?", a: 'lion' },
  { q: "Combien de cotes a un hexagone ?", a: '6' },
  { q: "Quel est le plus long fleuve du monde ?", a: 'nil' },
  { q: "Qui a peint la Joconde ?", a: 'vinci' },
  { q: "Quel est le plus petit pays du monde ?", a: 'vatican' },
  { q: "Combien de joueurs a une equipe de football sur le terrain ?", a: '11' },
  { q: "Quel est l'element chimique le plus abondant dans l'univers ?", a: 'hydrogene' },
  { q: "Combien d'os a le corps humain adulte ?", a: '206' },
  { q: "Quel instrument sert a mesurer la temperature ?", a: 'thermometre' },
  { q: "Quel est le plus grand desert chaud du monde ?", a: 'sahara' },
  { q: "Quel est le nom du satellite naturel de la Terre ?", a: 'lune' },
  { q: "Quelle est la plus haute montagne du monde ?", a: 'everest' },
  { q: "Combien de coeurs a une pieuvre ?", a: '3' },
  { q: "Quel est le plus grand organe interne du corps humain ?", a: 'foie' },
  { q: "Quel est le seul mammifere capable de voler ?", a: 'chauve-souris' },
  { q: "Quelle est la capitale mondiale reconnue de la mode ?", a: 'paris' },
  { q: "Combien de faces a un cube ?", a: '6' },
  { q: "Quel est le metal liquide a temperature ambiante ?", a: 'mercure' },
  { q: "Quel oiseau ne peut pas voler mais court tres vite ?", a: 'autruche' },
  { q: "Quelle est la vitesse approximative du son dans l'air (en m/s) ?", a: '340' },
  { q: "Quel est le plus grand pays du monde en superficie ?", a: 'russie' },
];

const CAPITAL_BANK = [
  { country: 'la France', capital: 'paris' },
  { country: 'le Canada', capital: 'ottawa' },
  { country: 'le Japon', capital: 'tokyo' },
  { country: "l'Italie", capital: 'rome' },
  { country: "l'Espagne", capital: 'madrid' },
  { country: "l'Allemagne", capital: 'berlin' },
  { country: 'le Portugal', capital: 'lisbonne' },
  { country: 'la Belgique', capital: 'bruxelles' },
  { country: 'la Suisse', capital: 'berne' },
  { country: 'le Royaume-Uni', capital: 'londres' },
  { country: 'la Russie', capital: 'moscou' },
  { country: 'la Chine', capital: 'pekin' },
  { country: 'le Bresil', capital: 'brasilia' },
  { country: "l'Egypte", capital: 'le caire' },
  { country: 'le Maroc', capital: 'rabat' },
  { country: 'le Mexique', capital: 'mexico' },
  { country: "l'Australie", capital: 'canberra' },
  { country: "l'Inde", capital: 'new delhi' },
  { country: "l'Argentine", capital: 'buenos aires' },
  { country: 'la Grece', capital: 'athenes' },
  { country: 'la Turquie', capital: 'ankara' },
  { country: 'la Suede', capital: 'stockholm' },
  { country: 'la Norvege', capital: 'oslo' },
  { country: 'les Pays-Bas', capital: 'amsterdam' },
  { country: 'la Pologne', capital: 'varsovie' },
  { country: "l'Autriche", capital: 'vienne' },
  { country: "l'Irlande", capital: 'dublin' },
  { country: 'la Coree du Sud', capital: 'seoul' },
  { country: 'la Thailande', capital: 'bangkok' },
  { country: 'le Vietnam', capital: 'hanoi' },
];

const SYNONYM_BANK = [
  { word: 'content', answers: ['heureux', 'joyeux', 'ravi'] },
  { word: 'rapide', answers: ['vite', 'véloce', 'prompt'] },
  { word: 'grand', answers: ['immense', 'gigantesque', 'vaste'] },
  { word: 'triste', answers: ['malheureux', 'chagrine', 'peiné'] },
  { word: 'beau', answers: ['magnifique', 'joli', 'splendide'] },
  { word: 'fort', answers: ['puissant', 'robuste', 'costaud'] },
  { word: 'intelligent', answers: ['malin', 'brillant', 'futé'] },
  { word: 'peur', answers: ['crainte', 'frayeur', 'effroi'] },
  { word: 'commencer', answers: ['debuter', 'entamer', 'demarrer'] },
  { word: 'finir', answers: ['terminer', 'achever', 'conclure'] },
  { word: 'facile', answers: ['simple', 'aise'] },
  { word: 'difficile', answers: ['dur', 'complique', 'ardu'] },
  { word: 'ami', answers: ['copain', 'camarade', 'pote'] },
  { word: 'maison', answers: ['demeure', 'logis', 'habitation'] },
  { word: 'chemin', answers: ['route', 'voie', 'sentier'] },
  { word: 'parler', answers: ['discuter', 'converser', 'bavarder'] },
  { word: 'regarder', answers: ['observer', 'contempler', 'fixer'] },
  { word: 'aider', answers: ['assister', 'soutenir', 'secourir'] },
  { word: 'colere', answers: ['rage', 'furie', 'irritation'] },
  { word: 'riche', answers: ['aise', 'fortune', 'prospere'] },
];

const ANTONYM_BANK = [
  { word: 'chaud', answers: ['froid'] },
  { word: 'grand', answers: ['petit'] },
  { word: 'rapide', answers: ['lent'] },
  { word: 'jour', answers: ['nuit'] },
  { word: 'monter', answers: ['descendre'] },
  { word: 'heureux', answers: ['triste', 'malheureux'] },
  { word: 'facile', answers: ['difficile'] },
  { word: 'plein', answers: ['vide'] },
  { word: 'debut', answers: ['fin'] },
  { word: 'ouvert', answers: ['ferme'] },
  { word: 'fort', answers: ['faible'] },
  { word: 'clair', answers: ['sombre', 'obscur'] },
  { word: 'ami', answers: ['ennemi'] },
  { word: 'gagner', answers: ['perdre'] },
  { word: 'jeune', answers: ['vieux', 'age'] },
  { word: 'propre', answers: ['sale'] },
  { word: 'riche', answers: ['pauvre'] },
  { word: 'aimer', answers: ['detester', 'hair'] },
  { word: 'dessus', answers: ['dessous'] },
  { word: 'entrer', answers: ['sortir'] },
];

const TRUEFALSE_BANK = [
  { statement: "Le soleil est une etoile.", answer: true },
  { statement: "Les humains ont 3 poumons.", answer: false },
  { statement: "L'eau bout a 100°C au niveau de la mer.", answer: true },
  { statement: "La Lune est plus grande que la Terre.", answer: false },
  { statement: "Les araignees sont des insectes.", answer: false },
  { statement: "Le Canada est plus grand que les Etats-Unis en superficie.", answer: true },
  { statement: "Une annee compte 12 mois.", answer: true },
  { statement: "Les manchots vivent en Arctique.", answer: false },
  { statement: "Le fer est attire par un aimant.", answer: true },
  { statement: "La tomate est un legume au sens botanique.", answer: false },
  { statement: "Le coeur humain a 4 cavites.", answer: true },
  { statement: "Les requins sont des mammiferes.", answer: false },
  { statement: "Paris est la capitale de la France.", answer: true },
  { statement: "Le diamant est fait de carbone.", answer: true },
  { statement: "Les chauves-souris sont aveugles.", answer: false },
  { statement: "Le Mont Everest est en Afrique.", answer: false },
  { statement: "L'oxygene est necessaire a la combustion.", answer: true },
  { statement: "Un triangle a quatre cotes.", answer: false },
  { statement: "Le corps humain contient plus de 60% d'eau.", answer: true },
  { statement: "Les kangourous vivent en Australie.", answer: true },
];

// ============================================================================
// 3) GENERATION D'IMAGE (canvas) — reutilise les 6 cartes HAVRE MINI JEUX
// ============================================================================

const ASSETS_DIR = path.join(__dirname, 'assets');
const imageCache = new Map();

async function getBaseImage(color) {
  if (imageCache.has(color)) return imageCache.get(color);
  const img = await loadImage(path.join(ASSETS_DIR, `${color}.png`));
  imageCache.set(color, img);
  return img;
}

function wrapText(ctx, text, maxWidth) {
  const words = text.split(' ');
  const lines = [];
  let line = '';
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = w;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * Dessine une carte "HAVRE MINI JEUX" avec un label, une question et un pied de page,
 * dans la couleur demandee.
 */
async function generateCard({ color, label, question, footer }) {
  const base = await getBaseImage(color);
  const W = base.width;
  const H = base.height;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(base, 0, 0);

  const theme = COLOR_THEME[color] || COLOR_THEME.blue;
  const boxX = W * 0.035;
  const boxY = H * 0.485;
  const boxX2 = W * 0.965;
  const boxY2 = H * 0.955;
  const boxW = boxX2 - boxX;
  const boxH = boxY2 - boxY;
  const cx = boxX + boxW / 2;

  // Label (petite etiquette en haut de la boite, sans emoji : canvas ne rend pas les emojis couleur)
  let labelHeight = 0;
  if (label) {
    const labelSize = Math.round(H * 0.05);
    ctx.font = `bold ${labelSize}px sans-serif`;
    ctx.fillStyle = theme.accent;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.shadowColor = theme.glow;
    ctx.shadowBlur = 8;
    ctx.fillText(label.toUpperCase(), boxX + boxW * 0.02, boxY + boxH * 0.05);
    ctx.shadowBlur = 0;
    labelHeight = boxH * 0.05 + labelSize;
  }

  // Question (centree, taille auto-ajustee pour tenir dans la boite)
  const availableH = boxH - labelHeight - boxH * (footer ? 0.14 : 0.05);
  let fontSize = Math.round(H * 0.1);
  let lines = [];
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  do {
    ctx.font = `bold ${fontSize}px sans-serif`;
    lines = wrapText(ctx, question, boxW * 0.94);
    const totalH = lines.length * fontSize * 1.18;
    if (totalH <= availableH) break;
    fontSize -= 2;
  } while (fontSize > 14);

  const lineHeight = fontSize * 1.18;
  const totalTextH = lines.length * lineHeight;
  const textZoneTop = boxY + labelHeight;
  const textZoneCenter = textZoneTop + (boxY2 - textZoneTop - (footer ? boxH * 0.1 : 0)) / 2;
  const startY = textZoneCenter - totalTextH / 2 + lineHeight / 2;

  ctx.fillStyle = theme.text;
  ctx.shadowColor = theme.glow;
  ctx.shadowBlur = 12;
  lines.forEach((l, i) => ctx.fillText(l, cx, startY + i * lineHeight));
  ctx.shadowBlur = 0;

  if (footer) {
    ctx.font = `${Math.round(H * 0.034)}px sans-serif`;
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(footer, cx, boxY2 - boxH * 0.035);
  }

  return canvas.toBuffer('image/png');
}

// ============================================================================
// 4) OUTILS DE GENERATION / VERIFICATION DE REPONSES
// ============================================================================

function normalize(str) {
  return String(str)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // retire les accents
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pickRandom(arr) {
  return arr[randInt(0, arr.length - 1)];
}

function scrambleLetters(word) {
  const letters = word.split('');
  let scrambled;
  let attempts = 0;
  do {
    scrambled = [...letters];
    for (let i = scrambled.length - 1; i > 0; i--) {
      const j = randInt(0, i);
      [scrambled[i], scrambled[j]] = [scrambled[j], scrambled[i]];
    }
    attempts++;
  } while (scrambled.join('') === word && attempts < 10);
  return scrambled.join(' - ');
}

function buildMathQuestion() {
  const ops = ['+', '-', '×'];
  const op = pickRandom(ops);
  let a, b, answer;
  if (op === '+') {
    a = randInt(10, 90);
    b = randInt(10, 90);
    answer = a + b;
  } else if (op === '-') {
    a = randInt(20, 99);
    b = randInt(1, a);
    answer = a - b;
  } else {
    a = randInt(2, 12);
    b = randInt(2, 12);
    answer = a * b;
  }
  return { text: `Combien font ${a} ${op} ${b} ?`, answer };
}

/** Genere une suite logique (arithmetique, geometrique ou type Fibonacci) et son terme suivant. */
function buildSequenceQuestion() {
  const kind = pickRandom(['arith', 'geom', 'fib']);

  if (kind === 'geom') {
    const start = randInt(1, 5);
    const ratio = randInt(2, 3);
    const seq = [start, start * ratio, start * ratio ** 2, start * ratio ** 3];
    const answer = start * ratio ** 4;
    return { text: `Quel est le prochain nombre de la suite ? ${seq.join(', ')}, ... ?`, answer };
  }

  if (kind === 'fib') {
    const a0 = randInt(1, 5);
    const a1 = randInt(1, 5);
    const a2 = a0 + a1;
    const a3 = a1 + a2;
    const answer = a2 + a3;
    return { text: `Quel est le prochain nombre de la suite ? ${a0}, ${a1}, ${a2}, ${a3}, ... ?`, answer };
  }

  const start = randInt(1, 20);
  const step = randInt(2, 9);
  const seq = [start, start + step, start + 2 * step, start + 3 * step];
  const answer = start + 4 * step;
  return { text: `Quel est le prochain nombre de la suite ? ${seq.join(', ')}, ... ?`, answer };
}

/**
 * Construit toutes les donnees d'une manche pour un type de jeu donne :
 * label/question/footer pour l'image, texte additionnel pour le message Discord,
 * et une fonction de verification isCorrect(content) => bool.
 */
function buildRound(gameKey) {
  const color = pickRandom(CARD_COLORS);
  const type = GAME_TYPES[gameKey];

  if (gameKey === 'number') {
    const min = 10;
    const max = 100;
    const secret = randInt(min, max);
    return {
      color,
      type,
      cardLabel: type.label,
      cardQuestion: `Je pense a un nombre entre ${min} et ${max}. Le premier a le deviner remporte les points !`,
      cardFooter: 'Ecris ta reponse dans le chat',
      extraText: null,
      isCorrect: (content) => parseInt(content.trim(), 10) === secret,
      revealAnswer: String(secret),
    };
  }

  if (gameKey === 'math') {
    const { text, answer } = buildMathQuestion();
    return {
      color,
      type,
      cardLabel: type.label,
      cardQuestion: text,
      cardFooter: 'Le premier bon resultat gagne',
      extraText: null,
      isCorrect: (content) => parseInt(content.trim(), 10) === answer,
      revealAnswer: String(answer),
    };
  }

  if (gameKey === 'word') {
    const word = pickRandom(WORD_BANK);
    const scrambled = scrambleLetters(word);
    return {
      color,
      type,
      cardLabel: type.label,
      cardQuestion: `Remets les lettres dans l'ordre : ${scrambled}`,
      cardFooter: 'Ecris le mot complet dans le chat',
      extraText: null,
      isCorrect: (content) => normalize(content) === normalize(word),
      revealAnswer: word,
    };
  }

  if (gameKey === 'riddle') {
    const r = pickRandom(RIDDLE_BANK);
    return {
      color,
      type,
      cardLabel: type.label,
      cardQuestion: r.q,
      cardFooter: 'Le premier a trouver gagne les points',
      extraText: null,
      isCorrect: (content) => normalize(content).includes(normalize(r.a)),
      revealAnswer: r.a,
    };
  }

  if (gameKey === 'emoji') {
    const e = pickRandom(EMOJI_BANK);
    return {
      color,
      type,
      cardLabel: type.label,
      cardQuestion: `Regarde les emojis ci-dessous et devine ce qu'ils representent !`,
      cardFooter: 'Le premier a deviner gagne les points',
      extraText: `## ${e.emojis}`,
      isCorrect: (content) => normalize(content).includes(normalize(e.answer)),
      revealAnswer: e.answer,
    };
  }

  if (gameKey === 'trivia') {
    const t = pickRandom(TRIVIA_BANK);
    return {
      color,
      type,
      cardLabel: type.label,
      cardQuestion: t.q,
      cardFooter: 'Le premier a repondre correctement gagne',
      extraText: null,
      isCorrect: (content) => normalize(content).includes(normalize(t.a)),
      revealAnswer: t.a,
    };
  }

  if (gameKey === 'capital') {
    const c = pickRandom(CAPITAL_BANK);
    return {
      color,
      type,
      cardLabel: type.label,
      cardQuestion: `Quelle est la capitale de ${c.country} ?`,
      cardFooter: 'Ecris le nom de la ville dans le chat',
      extraText: null,
      isCorrect: (content) => normalize(content).includes(normalize(c.capital)),
      revealAnswer: c.capital,
    };
  }

  if (gameKey === 'sequence') {
    const { text, answer } = buildSequenceQuestion();
    return {
      color,
      type,
      cardLabel: type.label,
      cardQuestion: text,
      cardFooter: 'Ecris le prochain nombre de la suite',
      extraText: null,
      isCorrect: (content) => parseInt(content.trim(), 10) === answer,
      revealAnswer: String(answer),
    };
  }

  if (gameKey === 'synonym') {
    const s = pickRandom(SYNONYM_BANK);
    return {
      color,
      type,
      cardLabel: type.label,
      cardQuestion: `Trouve un synonyme du mot : ${s.word}`,
      cardFooter: 'Un seul mot valide suffit',
      extraText: null,
      isCorrect: (content) => s.answers.some((a) => normalize(content).includes(normalize(a))),
      revealAnswer: s.answers.join(' / '),
    };
  }

  if (gameKey === 'antonym') {
    const s = pickRandom(ANTONYM_BANK);
    return {
      color,
      type,
      cardLabel: type.label,
      cardQuestion: `Trouve le contraire du mot : ${s.word}`,
      cardFooter: 'Un seul mot valide suffit',
      extraText: null,
      isCorrect: (content) => s.answers.some((a) => normalize(content).includes(normalize(a))),
      revealAnswer: s.answers.join(' / '),
    };
  }

  if (gameKey === 'truefalse') {
    const f = pickRandom(TRUEFALSE_BANK);
    return {
      color,
      type,
      cardLabel: type.label,
      cardQuestion: `Vrai ou Faux : ${f.statement}`,
      cardFooter: 'Reponds "vrai" ou "faux"',
      extraText: null,
      isCorrect: (content) => {
        const n = normalize(content);
        const truthy = ['vrai', 'v', 'oui', 'true'];
        const falsy = ['faux', 'f', 'non', 'false'];
        return f.answer ? truthy.includes(n) : falsy.includes(n);
      },
      revealAnswer: f.answer ? 'Vrai' : 'Faux',
    };
  }

  throw new Error(`Type de jeu inconnu: ${gameKey}`);
}

// ============================================================================
// 5) GESTIONNAIRE DE MANCHES (RoundManager)
// ============================================================================

const ROUND_DURATION_MS = 45_000;

class RoundManager {
  constructor(store) {
    this.store = store;
    this.active = null; // { round, channelId, endsAt, timeoutHandle }
    this.loopHandle = null;
    this.lastGameKey = null; // pour eviter de tirer deux fois de suite le meme mini-jeu
  }

  isRoundActive() {
    return this.active !== null;
  }

  /** (Re)programme la prochaine manche automatique selon les reglages actuels. */
  scheduleNext(client) {
    if (this.loopHandle) {
      clearTimeout(this.loopHandle);
      this.loopHandle = null;
    }
    const settings = this.store.getSettings();
    if (!settings.autoRunning || !settings.channelId) return;
    const seconds = Math.min(MAX_INTERVAL_SECONDS, Math.max(MIN_INTERVAL_SECONDS, settings.intervalSeconds || 60));
    const delay = seconds * 1000;
    this.loopHandle = setTimeout(() => {
      this.startRound(client).catch((err) => console.error('[round]', err));
    }, delay);
  }

  /** Lance une manche immediatement dans le salon configure. */
  async startRound(client, { forced = false } = {}) {
    const settings = this.store.getSettings();
    if (this.isRoundActive()) {
      return { ok: false, reason: 'already_active' };
    }
    if (!settings.channelId) {
      return { ok: false, reason: 'no_channel' };
    }
    const channel = await client.channels.fetch(settings.channelId).catch(() => null);
    if (!channel) {
      return { ok: false, reason: 'channel_missing' };
    }

    let pool = settings.enabledGames.length ? settings.enabledGames : Object.keys(GAME_TYPES);
    if (pool.length > 1 && this.lastGameKey) {
      const filtered = pool.filter((k) => k !== this.lastGameKey);
      if (filtered.length) pool = filtered;
    }
    const gameKey = pickRandom(pool);
    this.lastGameKey = gameKey;
    const round = buildRound(gameKey);

    const imageBuffer = await generateCard({
      color: round.color,
      label: round.cardLabel,
      question: round.cardQuestion,
      footer: round.cardFooter,
    });
    const attachment = new AttachmentBuilder(imageBuffer, { name: 'minigame.png' });

    const introLines = [
      `${round.type.emoji} **${round.type.label}** — ${settings.pointsPerWin} points a la cle !`,
    ];
    if (round.extraText) introLines.push(round.extraText);

    const container = new ContainerBuilder()
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(introLines.join('\n')))
      .addMediaGalleryComponents(
        new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL('attachment://minigame.png')),
      );

    const sent = await channel.send({ ...v2Payload(container), files: [attachment] });

    this.active = {
      round,
      channelId: channel.id,
      messageId: sent.id,
      endsAt: Date.now() + ROUND_DURATION_MS,
    };

    this.active.timeoutHandle = setTimeout(() => {
      this.endRound(client, { winner: null }).catch((err) => console.error('[round]', err));
    }, ROUND_DURATION_MS);

    return { ok: true, gameKey };
  }

  /** Verifie un message envoye dans le salon : s'il correspond a la manche active, la termine. */
  async checkAnswer(message, client) {
    if (!this.active) return;
    if (message.channelId !== this.active.channelId) return;
    if (message.author.bot) return;

    const { round } = this.active;
    if (!round.isCorrect(message.content)) return;

    const winner = message.author;
    await this.endRound(client, { winner, winningMessage: message });
  }

  async endRound(client, { winner, winningMessage }) {
    if (!this.active) return;
    const { round, channelId } = this.active;
    clearTimeout(this.active.timeoutHandle);
    this.active = null;

    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) {
      this.scheduleNext(client);
      return;
    }

    const settings = this.store.getSettings();

    if (winner) {
      const updated = this.store.addPoints(winner.id, winner.username, settings.pointsPerWin);
      const card = textCard(
        `🎉 **${winner.username}** a trouve la bonne reponse !\n` +
        `**Reponse :** ${round.revealAnswer}\n` +
        `+${settings.pointsPerWin} points (total : **${updated.points}** pts)`
      );
      const payload = v2Payload(card);
      if (winningMessage) {
        await winningMessage.reply(payload).catch(() => channel.send(payload));
      } else {
        await channel.send(payload);
      }
    } else {
      const card = textCard(`⏱️ Temps ecoule ! Personne n'a trouve.\n**Reponse :** ${round.revealAnswer}`);
      await channel.send(v2Payload(card));
    }

    this.scheduleNext(client);
  }

  /** Arrete tout : boucle et manche en cours (utilise quand l'admin clique sur "Arreter"). */
  stopAll() {
    if (this.loopHandle) clearTimeout(this.loopHandle);
    this.loopHandle = null;
    if (this.active && this.active.timeoutHandle) clearTimeout(this.active.timeoutHandle);
    // On laisse la manche en cours se terminer naturellement si elle existe deja ;
    // on empeche seulement la suivante d'etre programmee.
  }
}

module.exports = {
  Store,
  RoundManager,
  CARD_COLORS,
  GAME_TYPES,
  generateCard,
  ROUND_DURATION_MS,
  textCard,
  v2Payload,
};
