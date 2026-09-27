'use strict';

require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  SlashCommandBuilder,
} = require('discord.js');

const { Store, RoundManager, textCard, v2Payload } = require('./gameEngine');
const panel = require('./panel');

const TOKEN = process.env.DISCORD_TOKEN;
const ADMIN_ID = (process.env.ADMIN_ID || '1518434083133460652').trim();

if (!TOKEN) {
  console.error('❌ DISCORD_TOKEN manquant. Ajoute-le dans le fichier .env (ou les variables Railway).');
  process.exit(1);
}

const store = new Store();
const roundManager = new RoundManager(store);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Channel],
});

// ---------------------------------------------------------------------------
// Commandes slash
// ---------------------------------------------------------------------------

const commands = [
  new SlashCommandBuilder()
    .setName('minigamespanel')
    .setDescription('Ouvre le panneau de gestion des mini-jeux (reserve a l\'administrateur).'),
  new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Affiche le classement des mini-jeux.'),
  new SlashCommandBuilder()
    .setName('points')
    .setDescription('Affiche tes points de mini-jeux.'),
].map((c) => c.toJSON());

async function registerCommandsForGuild(guild) {
  try {
    await guild.commands.set(commands);
  } catch (err) {
    console.error(`[commands] Echec de l'enregistrement pour la guilde ${guild.id}`, err);
  }
}

client.once(Events.ClientReady, async (c) => {
  console.log(`✅ Connecte en tant que ${c.user.tag}`);
  for (const guild of c.guilds.cache.values()) {
    await registerCommandsForGuild(guild);
  }
  // Si une manche automatique etait active avant un redemarrage, on relance la boucle.
  roundManager.scheduleNext(c);
});

client.on(Events.GuildCreate, (guild) => {
  registerCommandsForGuild(guild);
});

// ---------------------------------------------------------------------------
// Interactions (slash commands, boutons, menus, modales)
// ---------------------------------------------------------------------------

function isAdmin(userId) {
  return userId === ADMIN_ID;
}

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'minigamespanel') {
        if (!isAdmin(interaction.user.id)) {
          await interaction.reply({ content: "⛔ Tu n'as pas la permission d'utiliser cette commande.", ephemeral: true });
          return;
        }
        await panel.sendPanel(interaction, store, roundManager);
        return;
      }

      if (interaction.commandName === 'leaderboard') {
        const top = store.getLeaderboard(10);
        const content =
          `## 🏆 Classement — Havre Mini Jeux\n` +
          (top.length
            ? top.map((u, i) => `**${i + 1}.** <@${u.userId}> — **${u.points}** pts (${u.wins} victoires)`).join('\n')
            : "Personne n'a encore marque de points. Attendez le prochain mini-jeu !");
        await interaction.reply(v2Payload(textCard(content)));
        return;
      }

      if (interaction.commandName === 'points') {
        const u = store.getUser(interaction.user.id);
        await interaction.reply(
          v2Payload(textCard(`💠 Tu as **${u.points}** point(s) et **${u.wins}** victoire(s).`), { ephemeral: true }),
        );
        return;
      }
    }

    // Tout ce qui suit (boutons, menus, modales) fait partie du panneau d'admin -> reserve a l'admin
    const isPanelInteraction =
      (interaction.isButton() && interaction.customId.startsWith('panel_')) ||
      (interaction.isAnySelectMenu && interaction.isAnySelectMenu() && interaction.customId.startsWith('panel_')) ||
      (interaction.isModalSubmit() && interaction.customId.startsWith('modal_'));

    if (isPanelInteraction) {
      if (!isAdmin(interaction.user.id)) {
        await interaction.reply({ content: "⛔ Tu n'as pas la permission d'utiliser ce panneau.", ephemeral: true });
        return;
      }

      if (interaction.isButton()) {
        await panel.handleButton(interaction, client, store, roundManager);
      } else if (interaction.isAnySelectMenu()) {
        await panel.handleSelectMenu(interaction, client, store, roundManager);
      } else if (interaction.isModalSubmit()) {
        await panel.handleModal(interaction, client, store, roundManager);
      }
    }
  } catch (err) {
    console.error('[interaction]', err);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: "❌ Une erreur est survenue.", ephemeral: true }).catch(() => {});
    }
  }
});

// ---------------------------------------------------------------------------
// Messages (reponses aux mini-jeux)
// ---------------------------------------------------------------------------

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  roundManager.checkAnswer(message, client).catch((err) => console.error('[checkAnswer]', err));
});

client.login(TOKEN);
