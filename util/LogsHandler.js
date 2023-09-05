const { EmbedBuilder } = require('discord.js');
const { HandleAlarmsAndUAVs } = require('./AlarmsHandler');
const { SendConnectionLogs, DetectCombatLog } = require('./AdminLogsHandler');

module.exports = {

  HandlePlayerLogs: async (client, guildId, stats, line) => {

    const connectTemplate    = /(.*) \| Player \"(.*)\" is connected \(id=(.*)\)/g;
    const disconnectTemplate = /(.*) \| Player \"(.*)\"\(id=(.*)\) has been disconnected/g;
    const positionTemplate   = /(.*) \| Player \"(.*)\" \(id=(.*) pos=<(.*)>\)/g;
    const damageTemplate     = /(.*) \| Player \"(.*)\" \(id=(.*) pos=<(.*)>\)\[HP\: (.*)\] hit by Player \"(.*)\" \(id=(.*) pos=<(.*)>\) into (.*) for (.*) damage \((.*)\) with (.*) from (.*) meters /g;
    const deadTemplate       = /(.*) \| Player \"(.*)\" \(DEAD\) \(id=(.*) pos=<(.*)>\)\[HP\: 0] hit by Player \"(.*)\" \(id=(.*) pos=<(.*)>\) into (.*) for (.*) damage \((.*)\) with (.*) from (.*) meters /g;

    if (line.includes(' connected')) {
      let data = [...line.matchAll(connectTemplate)][0];
      if (!data) return stats;

      let info = {
        time: data[1],
        player: data[2],
        playerID: data[3],
      };

      if (!client.exists(info.player) || !client.exists(info.playerID)) return stats;

      let playerStat = stats.find(stat => stat.playerID == info.playerID)
      let playerStatIndex = stats.indexOf(playerStat);
      if (playerStat == undefined) playerStat = client.getDefaultPlayerStats(info.player, info.playerID);
      
      let newDt = await client.getDateEST(info.time);
      
      playerStat.lastConnectionDate = newDt;
      playerStat.connected = true;

      if (playerStatIndex == -1) stats.push(playerStat);
      else stats[playerStatIndex] = playerStat;

      SendConnectionLogs(client, guildId, {
        time: info.time,
        player: info.player,
        connected: true,
        lastConnectionDate: null,
      });
    }

    if (line.includes(' disconnected')) {
      let data = [...line.matchAll(disconnectTemplate)][0];
      if (!data) return stats;

      let info = {
        time: data[1],
        player: data[2],
        playerID: data[3],
      }

      if (!client.exists(info.player) || !client.exists(info.playerID)) return stats;

      let playerStat = stats.find(stat => stat.playerID == info.playerID)
      let playerStatIndex = stats.indexOf(playerStat);
      if (playerStat == undefined) playerStat = client.getDefaultPlayerStats(info.player, info.playerID);

      let newDt = await client.getDateEST(info.time);
      let unixTime = Math.floor(newDt.getTime()/1000); // Seconds
      let oldUnixTime = Math.floor(playerStat.lastConnectionDate.getTime()/1000); // Seconds
      let sessionTimeSeconds = unixTime - oldUnixTime;
      if (!client.exists(playerStat.longestSessionTime)) playerStat.longestSessionTime = 0;

      playerStat.totalSessionTime = playerStat.totalSessionTime + sessionTimeSeconds;
      playerStat.lastSessionTime = sessionTimeSeconds;
      playerStat.longestSessionTime = sessionTimeSeconds > playerStat.longestSessionTime ? sessionTimeSeconds : playerStat.longestSessionTime;
      playerStat.connected = false;

      if (playerStatIndex == -1) stats.push(playerStat);
      else stats[playerStatIndex] = playerStat;

      SendConnectionLogs(client, guildId, {
        time: info.time,
        player: info.player,
        connected: false,
        lastConnectionDate: playerStat.lastConnectionDate,
      });

      DetectCombatLog(client, guildId, {
        time: info.time,
        player: info.player,
        lastDamageDate: playerStat.lastDamageDate,
        lastHitBy: playerStat.lastHitBy,
        lastDeathDate: playerStat.lastDeathDate,
      });
    }

    if (line.includes('pos=<') && !line.includes('hit by')) {
      let data = [...line.matchAll(positionTemplate)][0];
      if (!data) return stats;

      let info = {
        time: data[1],
        player: data[2],
        playerID: data[3],
        pos: data[4].split(', ').map(v => parseFloat(v))
      };

      if (!client.exists(info.player) || !client.exists(info.playerID)) return stats;

      let playerStat = stats.find(stat => stat.playerID == info.playerID)
      let playerStatIndex = stats.indexOf(playerStat);
      if (playerStat == undefined) playerStat = client.getDefaultPlayerStats(info.player, info.playerID);
      if (!client.exists(playerStat.lastConnectionDate)) playerStat.lastConnectionDate = await client.getDateEST(info.time);
      
      playerStat.lastPos = playerStat.pos;
      playerStat.pos = info.pos;
      playerStat.lastTime = playerStat.time;
      playerStat.lastDate = playerStat.date;
      playerStat.time = `${info.time} EST`;
      playerStat.date = await client.getDateEST(info.time);

      if (playerStatIndex == -1) stats.push(playerStat);
      else stats[playerStatIndex] = playerStat;

      if (line.includes('hit by') || line.includes('killed by')) return stats; // prevent additional information from being fed to Alarms & UAVs

      HandleAlarmsAndUAVs(client, guildId, {
        time: info.time,
        player: info.player,
        playerID: info.playerID,
        pos: info.pos,
      });

    }

    if (line.includes('hit by Player')) {
      let data = line.includes('(DEAD)') ? [...line.matchAll(deadTemplate)][0] : [...line.matchAll(damageTemplate)][0];
      if (!data) return stats;

      let info = {
        time: data[1],
        player: data[2],
        playerID: data[3],
        attacker: data[6],
        attackerID: data[7]
      }

      if (!client.exists(info.player) || !client.exists(info.playerID)) return stats;

      let playerStat = stats.find(stat => stat.playerID == info.playerID)
      let playerStatIndex = stats.indexOf(playerStat);
      if (playerStat == undefined) playerStat = client.getDefaultPlayerStats(info.player, info.playerID);

      let newDt = await client.getDateEST(info.time);

      playerStat.lastDamageDate = newDt;
      playerStat.lastHitBy = info.attacker;

      if (playerStatIndex == -1) stats.push(playerStat);
      else stats[playerStatIndex] = playerStat;
    }

    return stats;
  },

  HandleActivePlayersList: async (client, guildId) => {
    client.activePlayersTick = 0; // reset hour tick

    const res = await fetch(`https://api.nitrado.net/services/${client.config.Nitrado.ServerID}/gameservers`, {
      headers: {
        "Authorization": client.config.Nitrado.Auth
      }
    }).then(response => 
      response.json().then(data => data)
    ).then(res => res);
  
  
    let hostname = res.data.gameserver.settings.config.hostname;
    let map = res.data.gameserver.settings.config.mission.slice(12);  
    let status = res.data.gameserver.status;
    let slots = res.data.gameserver.slots;   
    
    let statusEmoji;
    let statusText;
    if (status === "started") {
      statusEmoji = "🟢";
      statusText = "Active";
    } else if (status === "stopped") {
      statusEmoji = "🔴";
      statusText = "Stopped";
    } else if (status === "restarting") {
      statusEmoji = "↻";
      statusText = "Restarting";
    } else {
      statusEmoji = "❓"; // Unknown status
      statusText = "Unknown Status";
    }
    
    let guild = await client.GetGuild(guildId);
    if (!client.exists(guild.playerstats)) guild.playerstats = [];
    if (!client.exists(guild.activePlayersChannel)) return;

    const channel = client.GetChannel(guild.activePlayersChannel);
    let activePlayers = guild.playerstats.filter(p => p.connected == true);

    let des = ``;
    for (let i = 0; i < activePlayers.length; i++) {
      des += `**- ${activePlayers[i].gamertag}**\n`;
    }
    const nodes = activePlayers.length === 0;
    const PlayersEmbed = new EmbedBuilder()
      .setColor(client.config.Colors.Default)
      .setTitle(`Online List  \` ${activePlayers.length} \`  Player${activePlayers.length>1?'s':''} Online`)
      .addFields(
        { name: 'Server:', value: `\` ${hostname} \``, inline: false },      
        { name: 'Map:', value: `\` ${map} \``, inline: true },
        { name: 'Status:', value: `\` ${statusEmoji} ${statusText} \``, inline: true }, 
        { name: 'Slots:', value: `\` ${slots} \``, inline: true }
      );
  
    const activePlayersEmbed = new EmbedBuilder()
      .setColor(client.config.Colors.Default)
      .setTimestamp()
      .setTitle(`Players Online:`)
      .setDescription(des || (nodes ? "No Players Online :(" : ""))
     
    return channel.send({ embeds: [PlayersEmbed, activePlayersEmbed] }).then(sentMessage => {      
      setTimeout(() => {
          sentMessage.delete().catch(error => client.sendError(channel, `HandleActivePlayersList Error: \n${error}`));
      }, 360000);
    });
  }
}