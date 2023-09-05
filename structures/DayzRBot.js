const { RegisterGlobalCommands, RegisterGuildCommands} = require("../util/RegisterSlashCommands");
const { Collection, Client, EmbedBuilder, Routes } = require('discord.js');
const MongoClient = require('mongodb').MongoClient;
const { REST } = require('@discordjs/rest');
const Logger = require("../util/Logger");
const mongoose = require('mongoose');

// custom util imports
const { DownloadNitradoFile, CheckServerStatus } = require('../util/NitradoAPI');
const { HandlePlayerLogs, HandleActivePlayersList } = require('../util/LogsHandler');
const { HandleKillfeed } = require('../util/KillfeedHandler');
const { HandleExpiredUAVs, HandleEvents } = require('../util/AlarmsHandler');
const { SendConnectionLogs } = require('../util/AdminLogsHandler');

const path = require("path");
const fs = require('fs');
const readline = require('readline');

const minute = 60000; // 1 minute in milliseconds
const arInterval = 600000; // Set auto-restart interval 10mins (600,000ms)

class DayzRBot extends Client {

  constructor(options, config) {
    super(options)

    this.config = config;
    this.commands = new Collection();
    this.interactionHandlers = new Collection();
    this.logger = new Logger(path.join(__dirname, "..", "logs/Logs.log"));
    this.timer = this.config.Dev == 'PROD.' ? minute * 5 : minute / 4;

    if (this.config.Token === "" || this.config.GuildID === "")
    throw new TypeError(
      "The config.js is not filled out. Please make sure nothing is blank, otherwise the bot will not work properly."
    );

    this.db;
    this.dbo;
    this.databaseConnected = false;
    this.arInterval = arInterval
    this.arIntervalId;  // Interval for auto-restart functions
    this.autoRestartInit();
    this.LoadCommandsAndInteractionHandlers();
    this.LoadEvents();

    this.Ready = false;
    this.activePlayersTick = 11;

    this.ws.on("INTERACTION_CREATE", async (interaction) => {
      const start = new Date().getTime();
      if (interaction.type!=3) {
        let GuildDB = await this.GetGuild(interaction.guild_id);

        for (const [factionID, data] of Object.entries(GuildDB.factionArmbands)) {
          const guild = this.guilds.cache.get(GuildDB.serverID);
          const role = guild.roles.cache.find(role => role.id == factionID);
          if (!role) {
            let query = {
              $pull: { 'server.usedArmbands': data.armband },
              $unset: { [`server.factionArmbands.${factionID}`]: "" },
            };
            await this.dbo.collection("guilds").updateOne({'server.serverID': GuildDB.serverID}, query, (err, res) => {
              if (err) return this.sendInternalError(interaction, err);
            });
          }
        }
        
        const command = interaction.data.name.toLowerCase();
        const args = interaction.data.options;

        client.log(`Interaction - ${command}`);

        //Easy to send respnose so ;)
        interaction.guild = await this.guilds.fetch(interaction.guild_id);
        interaction.send = async (message) => {
          const rest = new REST({ version: '10' }).setToken(client.config.Token);

          return await rest.post(Routes.interactionCallback(interaction.id, interaction.token), {
            body: {
              type: 4,
              data: message,
            }
          });
        };

        if (!this.databaseConnected) {
          let dbFailedEmbed = new EmbedBuilder()
            .setDescription(`**Internal Error:**\nUh Oh D:  Its not you, its me.\nThe bot has failed to connect to the database 5 times!\nContact the Developers\nhttps://discord.gg/YCXhvy9uZw`)
            .setColor(this.config.Colors.Red)
        
          return interaction.send({ embeds: [dbFailedEmbed] });
        }

        let cmd = client.commands.get(command);
        try {
          cmd.SlashCommand.run(this, interaction, args, { GuildDB }, start); // start is only used in ping / stats command
        } catch (err) {
          this.sendInternalError(interaction, err);
        }
      }
    });

    const client = this;
  }

  log(Text) { this.logger.log(Text); }
  error(Text) { this.logger.error(Text); }

  async getDateEST(time) {
    let timeArray = time.split(' ')[0].split(':')
    let t = new Date(); // Get current date & time (UTC)
    let f = new Date(t.getTime() - 4 * 3600000) // Convert UTC into EST time to roll back the day as necessary
    f.setUTCHours(timeArray[0], timeArray[1], timeArray[2]);  // Apply the supplied EST time to the converted date (EST is the timezone produced from the Nitrado logs).
    return new Date(f.getTime() + 4 * 3600000);  // Add EST time offset to return timestamp in UTC
  }

  async readLogs(guildId) {
    const fileStream = fs.createReadStream('./logs/server-logs.ADM');
  
    let logHistoryDir = path.join(__dirname, '..', 'logs', 'history-logs.ADM.json');
    let history;
    try {
      history = JSON.parse(fs.readFileSync(logHistoryDir));
    } catch (err) {
      history = {
        lastLog: null
      };
    }
    
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });
    let lines = [];
    for await (const line of rl) { lines.push(line); }
    
    let logIndex = lines.indexOf(history.lastLog);
    
    let guild = await this.GetGuild(guildId);
    if (!this.exists(guild.playerstats)) guild.playerstats = [];
    let s = guild.playerstats;

    s.map(p => p.connected = false) // assume all players not connected
    
    for (let i = logIndex + 1; i < lines.length; i++) {
      if (line.includes('| ####')) continue;
      if (lines[i].includes("(id=Unknown") || lines[i].includes("Player \"Unknown Entity\"")) continue;
      if ((i - 1) >= 0 && lines[i] == lines[i-1]) continue; // continue if this line is a duplicate of the last line
      if (lines[i].includes('connected') || lines[i].includes('pos=<') || lines[1].includes('hit by Player')) s = await HandlePlayerLogs(this, guildId, s, lines[i]);
      if (lines[i].includes('killed by  with') || lines[i].includes('killed by LandMineTrap')) s = await HandleKillfeed(this, guildId, s, lines[i]); // Handles explosive deaths
      if (!(i + 1 >= lines.length) && lines[i + 1].includes('killed by') && lines[i].includes('TransportHit')) s = await HandleKillfeed(this, guildId, s, lines[i]) // Handles vehicle deaths
      if (!(i + 1 >= lines.length) && lines[i + 1].includes('killed by Player') && lines[i].includes('hit by Player')) s = await HandleKillfeed(this, guildId, s, lines[i]); // Handles regular deaths
      if (lines[i].includes('killed by Player') && !lines[i - 1].includes('hit by Player')) s = await HandleKillfeed(this, guildId, s, lines[i]); // Handles deaths missing hit by log
    }

    const playerTemplate = /(.*) \| Player \"(.*)\" \(id=(.*) pos=<(.*)>\)/g;
    let previouslyConnected = s.filter(p => p.connected); // All players with connection log captured above and no disconnect log
    let detectedAsConnected = [];
    let lastDetectedTime;

    for (let i = lines.length - 1; i > 0; i--) {
      if (lines[i].includes('PlayerList log:')) {
        for (let j = i + 1; i < lines.length; j++) {
          let line = lines[j];
          if (line.includes('| ####')) break;

          let data = [...line.matchAll(playerTemplate)][0];
          if (!data) continue;

          let info = {
            time: data[1],
            player: data[2],
            playerID: data[3],
          };

          lastDetectedTime = info.time;

          if (!this.exists(info.player) || !this.exists(info.playerID)) continue;

          let playerStat = s.find(stat => stat.playerID == info.playerID);
          let playerStatIndex = s.indexOf(playerStat);
          if (playerStat == undefined) playerStat = this.getDefaultPlayerStats(info.player, info.playerID);
          if (!previouslyConnected.includes(playerStat)) {

            // This player was not connected before, i.e missing connection log?
            playerStat.connected = true;
            playerStat.lastConnectionDate = this.getDateEST(info.time); // Assume connected now
            detectedAsConnected.push()
          }

          if (playerStatIndex == -1) s.push(playerStat);
          else s[playerStatIndex] = playerStat;
          detectedAsConnected.push(playerStat);
        }
        break;
      }
    }

    for (let i = 0; i < previouslyConnected.length; i++) {
      if (!detectedAsConnected.includes(previouslyConnected[i])) {

        // This player disconnected without a disconnect log appearing.
        client.log('Players disconnected withouth disconnect log: this can happen!!!') // debug proof
        
        let playerStat = spreviouslyConnected[i];
        let playerStatIndex = s.indexOf(playerStat);
        
        playerStat.connected = false;
        s[playerStatIndex] = playerStat;
        
        SendConnectionLogs(client, guildId, {
          time: lastDetectedTime,
          player: playerStat.gamertag,
          connected: false,
          lastConnectionDate: playerStat.lastConnectionDate,
        });
      }
    }

    await this.dbo.collection("guilds").updateOne({ "server.serverID": guildId }, {
      $set: {
        "server.playerstats": s
      }
    }, (err, res) => {
      if (err) this.sendError(this.GetChannel(guild.adminLogsChannel), err);
    });

    history.lastLog = lines[lines.length-1];

    // write JSON string to a file
    fs.writeFileSync(logHistoryDir, JSON.stringify(history));
  }

  async logsUpdateTimer(c) {
    let t = new Date();
    // c.log(`...Logs Tick - ${t.getHours()}:${t.getMinutes()}:${t.getSeconds()}...`);
    c.activePlayersTick++;
    
    await DownloadNitradoFile(c, `/games/${c.config.Nitrado.UserID}/noftp/dayzxb/config/DayZServer_X1_x64.ADM`, './logs/server-logs.ADM').then(async (status) => {
      if (status == -1) return c.error('...Failed to Download logs...');
      // c.log('...Downloaded logs...');
      await c.readLogs(c.config.GuildID).then(async () => {
        // c.log('...Analyzed logs...');
        HandleExpiredUAVs(c, c.config.GuildID);
        HandleEvents(c, c.config.GuildID)
        if (c.activePlayersTick == 12) await HandleActivePlayersList(c, c.config.GuildID);
      })
    });
  }

  async connectMongo(mongoURI, dbo) {
    let failed = false;

    let dbLogDir = path.join(__dirname, '..', 'logs', 'database-logs.json');
    let databaselogs;
    try {
      databaselogs = JSON.parse(fs.readFileSync(dbLogDir));
    } catch (err) {
      databaselogs = {
        attempts: 0,
        connected: false,
      };
    }

    if (databaselogs.attempts >= 5) {
      this.error('Failed to connect to mongodb after multiple attempts');
      return; // prevent further attempts
    }

    try {
      // Connect to Mongo database.
      this.db = await MongoClient.connect(mongoURI, {connectTimeoutMS: 1000});
      this.dbo = this.db.db(dbo);
      mongoose.connect(`mongodb://${mongoURI.split('@')[1]}/${dbo}`, {
        authSource: "admin",
        user: mongoURI.split('//')[1].split(':')[0],
        pass: mongoURI.split('//')[1].split(':')[1].split('@')[0],
        useNewUrlParser: true, 
      }).catch(e=>this.error(e));
      this.log('Successfully connected to mongoDB');
      databaselogs.connected = true;
      databaselogs.attempts = 0; // reset attempts
      this.databaseConnected = true;
    } catch (err) {
      databaselogs.attempts++;
      this.error(`Failed to connect to mongodb (mongodb://${mongoURI.split('@')[1]}/${dbo}): attempt ${databaselogs.attempts} - Error: ${err}`);
      failed = true;
    }

    // write JSON string to a file
    fs.writeFileSync(dbLogDir, JSON.stringify(databaselogs));

    if (failed) process.exit(-1);
  }

  async autoRestartInit() {
    // Wait for MongoDB to connect
    await this.connectMongo(this.config.mongoURI, this.config.dbo);

    let is_enabled = undefined;
    if (this.databaseConnected) is_enabled = await this.dbo.collection("guilds").findOne({"server.autoRestart":1}).then(is_enabled => is_enabled);

    if (is_enabled) {
      this.log('Starting periodic Nitrado server status check.');
      this.arIntervalId = setInterval(CheckServerStatus, this.arInterval, this);
    }
  }

  exists(n) {return null != n && undefined != n && "" != n}

  secondsToDhms(seconds) {
    seconds = Number(seconds);
    const d = Math.floor(seconds / (3600*24));
    const h = Math.floor(seconds % (3600*24) / 3600);
    const m = Math.floor(seconds % 3600 / 60);
    const s = Math.floor(seconds % 60);
    
    const dDisplay = d > 0 ? d + (d == 1 ? " day, " : " days, ") : "";
    const hDisplay = h > 0 ? h + (h == 1 ? " hour, " : " hours, ") : "";
    const mDisplay = m > 0 ? m + (m == 1 ? " minute, " : " minutes, ") : "";
    const sDisplay = s > 0 ? s + (s == 1 ? " second" : " seconds") : "";
    return dDisplay + hDisplay + mDisplay + sDisplay;
  }

  LoadCommandsAndInteractionHandlers() {
    let CommandsDir = path.join(__dirname, '..', 'commands');
    fs.readdir(CommandsDir, (err, files) => {
      if (err) this.error(err);
      else
        files.forEach((file) => {
          let cmd = require(CommandsDir + "/" + file);
          if (!this.exists(cmd.name) || !this.exists(cmd.description))
            return this.error(
              "Unable to load Command: " +
                file.split(".")[0] +
                ", Reason: File doesn't had name/desciption"
            );
          this.commands.set(file.split(".")[0].toLowerCase(), cmd);
          if (this.exists(cmd.Interactions)) {
            for (let [interaction, handler] of Object.entries(cmd.Interactions)) {
              this.interactionHandlers.set(interaction, handler);
            }
          }
          this.log("Command Loaded: " + file.split(".")[0]);
        });
    });
  }

  LoadEvents() {
    let EventsDir = path.join(__dirname, '..', 'events');
    fs.readdir(EventsDir, (err, files) => {
      if (err) this.error(err);
      else
        files.forEach((file) => {
          const event = require(EventsDir + "/" + file);
          if (['interactionCreate','guildMemberAdd'].includes(file.split(".")[0])) this.on(file.split(".")[0], i => event(this, i));
          else this.on(file.split(".")[0], event.bind(null, this));
          this.log("Event Loaded: " + file.split(".")[0]);
        });
    });
  }

  // Allows shorter lines of code elsewhere
  GetChannel(channel_id) { return this.channels.cache.get(channel_id); }

  sendError(Channel, Error) {
    this.error(Error);
    let embed = new EmbedBuilder()
      .setColor(this.config.Red)
      .setDescription(Error);

    Channel.send(embed);
  }

  // Handles internal errors for slash commands. E.g failed to update database from slash command.
  sendInternalError(Interaction, Error) {
    this.error(Error);
    const embed = new EmbedBuilder()
      .setDescription(`**Internal Error:**\nUh Oh D:  Its not you, its me.\nThis command has crashed\nContact the Developers\nhttps://discord.gg/YCXhvy9uZw`)
      .setColor(this.config.Colors.Red)
  
    try {
      Interaction.send({ embeds: [embed] });
    } catch {
      Interaction.update({ embeds: [embed], components: [] });
    }
  }

  // Calls register for guild and global commands
  RegisterSlashCommands() {
    RegisterGlobalCommands(this);
    this.guilds.cache.forEach((guild) => RegisterGuildCommands(this, guild.id));
  }

  getDefaultSettings(GuildId) {
    return {
      serverID: GuildId,
      autoRestart: 0,
      allowedChannels: [],
      killfeedChannel: "",
      showKillfeedCoords: false,
      connectionLogsChannel: "",
      activePlayersChannel: "",
      welcomeChannel: "",
      factionArmbands: {},
      usedArmbands: [],
      excludedRoles: [],
      botAdminRoles: [],
      playerstats: [],
      alarms: [],
      events: [],
      uavs: [],
      incomeRoles: [],
      incomeLimiter: 168, // # of hours in 7 days
      linkedGamertagRole: "",
      startingBalance: 500,
      uavPrice: 50000,
      empPrice: 500000,
      memberRole: "",
      adminRole: "",
    }
  }

  getDefaultPlayerStats(gt, pID) {
    return {
      gamertag: gt,
      playerID: pID,
      discordID: "",
      KDR: 0.00,
      kills: 0,
      deaths: 0,
      killStreak: 0,
      bestKillStreak: 0,
      longestKill: 0,
      deathStreak: 0,
      worstDeathStreak: 0,
      pos: [],
      lastPos: [],
      time: null,
      lastTime: null,
      lastConnectionDate: null,
      lastDamageDate: null,
      lastDeathDate: null,
      lastHitBy: null,
      connected: false,
      totalSessionTime: 0,
      lastSessionTime: 0,
      longestSessionTime: 0,
      bounties: [],
    }
  }

  async GetGuild(GuildId) {
    let guild = undefined;
    if (this.databaseConnected) guild = await this.dbo.collection("guilds").findOne({"server.serverID":GuildId}).then(guild => guild);

    // If guild not found, generate guild default
    if (!guild) {
      guild = {}
      guild.server = this.getDefaultSettings(GuildId);
      if (this.databaseConnected) {
        this.dbo.collection("guilds").insertOne(guild, (err, res) => {
          if (err) throw err;
        });
      }
    }

    return {
      serverID: GuildId,
      autoRestart: guild.server.autoRestart,
      customChannelStatus: guild.server.allowedChannels.length > 0 ? true : false,
      allowedChannels: guild.server.allowedChannels,
      factionArmbands: guild.server.factionArmbands,
      usedArmbands: guild.server.usedArmbands,
      excludedRoles: guild.server.excludedRoles,
      hasBotAdmin: guild.server.botAdminRoles.length > 0 ? true : false,
      botAdminRoles: guild.server.botAdminRoles,
      playerstats: guild.server.playerstats,
      alarms: guild.server.alarms,
      events: guild.server.events,
      uavs: guild.server.uavs,
      killfeedChannel: guild.server.killfeedChannel,
      showKillfeedCoords: guild.server.showKillfeedCoords,
      connectionLogsChannel: guild.server.connectionLogsChannel,
      welcomeChannel: guild.server.welcomeChannel,
      activePlayersChannel: guild.server.activePlayersChannel,
      linkedGamertagRole: guild.server.linkedGamertagRole,
      incomeRoles: guild.server.incomeRoles,
      incomeLimiter: guild.server.incomeLimiter,
      startingBalance: guild.server.startingBalance,
      uavPrice: guild.server.uavPrice,
      memberRole: guild.server.memberRole,
      adminRole: guild.server.adminRole,
    };
  }

  build() {
    this.login(this.config.Token);
  }
}

module.exports = DayzRBot;
