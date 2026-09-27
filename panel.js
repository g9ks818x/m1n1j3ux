'use strict';

/**
 * panel.js
 * --------
 * Construit et gere le panneau d'administration interactif ouvert par /minigamespanel.
 * Toute l'interface utilise les Components V2 de Discord (Container / TextDisplay / Separator),
 * sans aucune couleur d'accent, pour un rendu neutre qui se fond dans le theme Discord.
 * Tout se pilote via des boutons, des menus de selection et deux petites fenetres modales
 * (intervalle + points par victoire), sans avoir besoin d'autres commandes slash.
 */

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ChannelSelectMenuBuilder,
  ChannelType,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  MessageFlags,
} = require('discord.js');
const { GAME_TYPES, v2Payload } = require('./gameEngine');

function buildPanelContainer(store, roundManager) {
  const s = store.getSettings();
  const leaderboard = store.getLeaderboard(5);

  const gamesList = Object.values(GAME_TYPES)
    .map((g) => `${s.enabledGames.includes(g.key) ? '✅' : '⬛'} ${g.emoji} ${g.label}`)
    .join('\n');

  const top = leaderboard.length
    ? leaderboard.map((u, i) => `**${i + 1}.** <@${u.userId}> — ${u.points} pts (${u.wins} victoires)`).join('\n')
    : '_Aucun point enregistre pour le moment._';

  const statusLine = s.autoRunning ? '🟢 En cours (rounds automatiques)' : '🔴 Arrete';
  const activeLine = roundManager.isRoundActive() ? '\n⏳ *Une manche est en cours en ce moment.*' : '';

  const container = new ContainerBuilder()
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `## 🎮 Panneau de gestion — Havre Mini Jeux\n` +
        `**Statut :** ${statusLine}\n` +
        `**Salon :** ${s.channelId ? `<#${s.channelId}>` : '_non defini_'}\n` +
        `**Intervalle :** ${s.intervalSeconds} seconde(s)\n` +
        `**Points par victoire :** ${s.pointsPerWin}${activeLine}`
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`**Mini-jeux actifs**\n${gamesList}`))
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`**Top 5 joueurs**\n${top}`))
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent('_Seul toi peux utiliser ce panneau._'));

  return container;
}

function buildPanelActionRows(store) {
  const s = store.getSettings();

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('panel_start')
      .setLabel('Demarrer')
      .setEmoji('▶️')
      .setStyle(ButtonStyle.Success)
      .setDisabled(s.autoRunning),
    new ButtonBuilder()
      .setCustomId('panel_stop')
      .setLabel('Arreter')
      .setEmoji('⏹️')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(!s.autoRunning),
    new ButtonBuilder()
      .setCustomId('panel_force')
      .setLabel('Lancer une manche maintenant')
      .setEmoji('🎲')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('panel_refresh')
      .setLabel('Actualiser')
      .setEmoji('🔄')
      .setStyle(ButtonStyle.Secondary),
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder()
      .setCustomId('panel_channel_select')
      .setPlaceholder('Choisir le salon des mini-jeux')
      .addChannelTypes(ChannelType.GuildText)
      .setMinValues(1)
      .setMaxValues(1),
  );

  const row3 = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('panel_games_select')
      .setPlaceholder('Choisir les mini-jeux actifs')
      .setMinValues(1)
      .setMaxValues(Object.keys(GAME_TYPES).length)
      .addOptions(
        Object.values(GAME_TYPES).map((g) => ({
          label: g.label,
          value: g.key,
          emoji: g.emoji,
          default: s.enabledGames.includes(g.key),
        })),
      ),
  );

  const row4 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('panel_set_interval')
      .setLabel("Changer l'intervalle")
      .setEmoji('⏱️')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('panel_set_points')
      .setLabel('Changer les points/victoire')
      .setEmoji('💠')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('panel_reset_points')
      .setLabel('Reinitialiser les points')
      .setEmoji('🗑️')
      .setStyle(ButtonStyle.Danger),
  );

  return [row1, row2, row3, row4];
}

function buildPanelPayload(store, roundManager) {
  const container = buildPanelContainer(store, roundManager);
  const rows = buildPanelActionRows(store);
  return v2Payload([container, ...rows]);
}

async function sendPanel(interaction, store, roundManager) {
  await interaction.reply(buildPanelPayload(store, roundManager));
}

async function refreshPanelMessage(interaction, store, roundManager) {
  await interaction.update(buildPanelPayload(store, roundManager));
}

async function handleButton(interaction, client, store, roundManager) {
  const id = interaction.customId;

  if (id === 'panel_start') {
    if (!store.getSettings().channelId) {
      await interaction.reply(v2Payload(require('./gameEngine').textCard('⚠️ Choisis d\'abord un salon avec le menu ci-dessous.'), { ephemeral: true }));
      return;
    }
    store.updateSettings({ autoRunning: true });
    await roundManager.startRound(client);
    roundManager.scheduleNext(client);
    await refreshPanelMessage(interaction, store, roundManager);
    return;
  }

  if (id === 'panel_stop') {
    store.updateSettings({ autoRunning: false });
    roundManager.stopAll();
    await refreshPanelMessage(interaction, store, roundManager);
    return;
  }

  if (id === 'panel_force') {
    const res = await roundManager.startRound(client, { forced: true });
    if (!res.ok) {
      const messages = {
        already_active: '⚠️ Une manche est deja en cours.',
        no_channel: '⚠️ Choisis d\'abord un salon avec le menu ci-dessous.',
        channel_missing: '⚠️ Le salon configure est introuvable (a-t-il ete supprime ?).',
      };
      const { textCard } = require('./gameEngine');
      await interaction.reply(v2Payload(textCard(messages[res.reason] || '⚠️ Impossible de lancer une manche.'), { ephemeral: true }));
      return;
    }
    await refreshPanelMessage(interaction, store, roundManager);
    return;
  }

  if (id === 'panel_refresh') {
    await refreshPanelMessage(interaction, store, roundManager);
    return;
  }

  if (id === 'panel_reset_points') {
    const { textCard } = require('./gameEngine');
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('panel_reset_confirm').setLabel('Confirmer la reinitialisation').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('panel_reset_cancel').setLabel('Annuler').setStyle(ButtonStyle.Secondary),
    );
    const container = textCard('❗ Es-tu sur de vouloir remettre **tous** les points a zero ? Cette action est irreversible.');
    await interaction.reply({ ...v2Payload([container, row], { ephemeral: true }) });
    return;
  }

  if (id === 'panel_reset_confirm') {
    store.resetPoints();
    const { textCard } = require('./gameEngine');
    await interaction.update(v2Payload(textCard('✅ Tous les points ont ete reinitialises.')));
    return;
  }

  if (id === 'panel_reset_cancel') {
    const { textCard } = require('./gameEngine');
    await interaction.update(v2Payload(textCard('Annule.')));
    return;
  }

  if (id === 'panel_set_interval') {
    const modal = new ModalBuilder().setCustomId('modal_interval').setTitle("Intervalle entre les manches");
    const input = new TextInputBuilder()
      .setCustomId('input_interval')
      .setLabel('Secondes entre les manches (5-86400)')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('Ex : 25')
      .setValue(String(store.getSettings().intervalSeconds))
      .setRequired(true);
    modal.addComponents(new ActionRowBuilder().addComponents(input));
    await interaction.showModal(modal);
    return;
  }

  if (id === 'panel_set_points') {
    const modal = new ModalBuilder().setCustomId('modal_points').setTitle('Points par victoire');
    const input = new TextInputBuilder()
      .setCustomId('input_points')
      .setLabel('Nombre de points gagnes par bonne reponse')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('Ex : 5')
      .setValue(String(store.getSettings().pointsPerWin))
      .setRequired(true);
    modal.addComponents(new ActionRowBuilder().addComponents(input));
    await interaction.showModal(modal);
    return;
  }
}

async function handleSelectMenu(interaction, client, store, roundManager) {
  if (interaction.customId === 'panel_channel_select') {
    const channelId = interaction.values[0];
    store.updateSettings({ channelId });
    await refreshPanelMessage(interaction, store, roundManager);
    return;
  }

  if (interaction.customId === 'panel_games_select') {
    store.updateSettings({ enabledGames: interaction.values });
    await refreshPanelMessage(interaction, store, roundManager);
    return;
  }
}

async function handleModal(interaction, client, store, roundManager) {
  if (interaction.customId === 'modal_interval') {
    const raw = interaction.fields.getTextInputValue('input_interval');
    const seconds = parseInt(raw, 10);
    if (!Number.isFinite(seconds) || seconds < 5 || seconds > 86400) {
      const { textCard } = require('./gameEngine');
      await interaction.reply(v2Payload(textCard('⚠️ Entre un nombre de secondes valide (5 a 86400).'), { ephemeral: true }));
      return;
    }
    store.updateSettings({ intervalSeconds: seconds });
    roundManager.scheduleNext(client);
    await interaction.deferUpdate();
    await interaction.message?.edit?.(buildPanelPayload(store, roundManager)).catch(() => {});
    return;
  }

  if (interaction.customId === 'modal_points') {
    const raw = interaction.fields.getTextInputValue('input_points');
    const pts = parseInt(raw, 10);
    if (!Number.isFinite(pts) || pts < 1 || pts > 1000) {
      const { textCard } = require('./gameEngine');
      await interaction.reply(v2Payload(textCard('⚠️ Entre un nombre de points valide (1 a 1000).'), { ephemeral: true }));
      return;
    }
    store.updateSettings({ pointsPerWin: pts });
    await interaction.deferUpdate();
    await interaction.message?.edit?.(buildPanelPayload(store, roundManager)).catch(() => {});
    return;
  }
}

module.exports = {
  sendPanel,
  handleButton,
  handleSelectMenu,
  handleModal,
};
