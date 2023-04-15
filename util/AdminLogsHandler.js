const { EmbedBuilder } = require('discord.js');

module.exports = {
  
  SendConnectionLogs: async (client, guildId, data) => {
    
    let guild = await client.GetGuild(guildId);
    if (!client.exists(guild.connectionLogsChannel)) return;
    const channel = client.channels.cache.get(guild.connectionLogsChannel);

    let newDt = await client.getDateEST(data.time);
    let unixTime = Math.floor(newDt.getTime()/1000);

    let connectionLog = new EmbedBuilder()
      .setColor(data.connected ? client.config.Colors.Green : client.config.Colors.Red)
      .setDescription(`**${data.connected ? 'Connect' : 'Disconnect'} Event - <t:${unixTime}>\n${data.player} ${data.connected ? 'Connected' : 'Disconnected'}**`);

    if (!data.connected) {
      if (!(data.lastConnectionDate == null)) {
        let oldUnixTime = Math.floor(data.lastConnectionDate.getTime()/1000);
        let sessionTime = client.secondsToDhms(unixTime - oldUnixTime);
        connectionLog.addFields({ name: '**Session Time**', value: `**${sessionTime}**`, inline: false });
      } else connectionLog.addFields({ name: '**Session Time**', value: `**Unknown**`, inline: false });
    }

    if (client.exists(channel)) await channel.send({ embeds: [connectionLog] });
  },

  DetectCombatLog: async (client, guildId, data) => {
    if (data.lastDamageDate == null) return;
    
    let newDt = await client.getDateEST(data.time);

    let diffMs = (newDt - data.lastDamageDate)
    let diffMins = Math.round(((diffMs % 86400000) % 3600000) / 60000); // minutes

    if (diffMins > 5) return;

    let guild = await client.GetGuild(guildId);
    if (!client.exists(guild.connectionLogsChannel)) return;
    const channel = client.channels.cache.get(guild.connectionLogsChannel);
    if (!channel) return;

    let unixTime = Math.floor(newDt.getTime()/1000);

    let combatLog = new EmbedBuilder()
      .setColor(client.config.Colors.Red)
      .setDescription(`**NOTICE:**\n**${data.player}** has combat logged at <t:${unixTime}> when fighting **${data.lastHitBy}**`);
  
    if (client.exists(guild.adminRole)) channel.send({ content: `<@&${guild.adminRole}>` });

    return channel.send({ embeds: [combatLog] });
  }
}