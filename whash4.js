const Discord = require('discord.js');
const fs = require('fs');
const fsPromises = require('fs').promises;
const https = require('https');
const path = require('path');
const sharp = require('sharp');
require('dotenv').config();

// Bot configuration
const BOT_INFO = {
  startTime: '2025-02-06 11:58:41',
  operator: 'noname9006',
  memoryLimit: 800,
  similarityThreshold: 12,
  version: '1.1.0',
  outputDir: `duplicates_${new Date().toISOString().replace(/[:.]/g, '-')}`
};

// Logging utility
const LOGGING_UTILS = {
  logDir: 'logs',
  startTime: BOT_INFO.startTime,
  operator: BOT_INFO.operator,
  logEnhanced(data) {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] ${data.type}: ${JSON.stringify(data.data)}\n`;
    console.log(logEntry.trim());
    fsPromises.appendFile(path.join(this.logDir, `bot_log_${this.startTime.split(' ')[0]}.log`), logEntry)
      .catch(error => console.error('Logging error:', error));
  }
};

// Ensure logs directory exists
if (!fs.existsSync(LOGGING_UTILS.logDir)){
  fs.mkdirSync(LOGGING_UTILS.logDir, { recursive: true });
}

// Helper to get a unique filename if one already exists in the folder.
function getUniqueFilename(folder, filename) {
  const parsed = path.parse(filename);
  let uniqueName = filename;
  let counter = 1;
  while (fs.existsSync(path.join(folder, uniqueName))) {
    uniqueName = `${parsed.name}_${String(counter).padStart(2, '0')}${parsed.ext}`;
    counter++;
  }
  return uniqueName;
}

// Create a Discord client for v12.
const client = new Discord.Client();

// Data structure to track image groups.
const imageDatabase = new Map();

// Helper functions for time formatting.
function formatElapsedTime(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`;
  } else {
    return `${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`;
  }
}
function getCurrentFormattedTime() {
  return new Date().toISOString().replace('T', ' ').split('.')[0];
}

// Download image from URL and save to folder with filename.
async function downloadImage(url, folderPath, filename) {
  await fsPromises.mkdir(folderPath, { recursive: true });
  const filepath = path.join(folderPath, filename);
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if(res.statusCode !== 200){
        reject(new Error(`Failed to download image: ${res.statusCode}`));
        return;
      }
      const fileStream = fs.createWriteStream(filepath);
      res.pipe(fileStream);
      fileStream.on('finish', () => {
        fileStream.close();
        resolve(filepath);
      });
      fileStream.on('error', (err) => {
        fs.unlink(filepath, () => {});
        reject(err);
      });
    }).on('error', (err) => reject(err));
  });
}

// Compute 2D DCT for a square matrix of size N x N.
function computeDCT(matrix, N) {
  const dct = Array.from({ length: N }, () => new Array(N).fill(0));
  const PI = Math.PI;
  for (let u = 0; u < N; u++) {
    for (let v = 0; v < N; v++) {
      let sum = 0;
      for (let x = 0; x < N; x++) {
        for (let y = 0; y < N; y++) {
          sum += matrix[x][y] *
            Math.cos(((2 * x + 1) * u * PI) / (2 * N)) *
            Math.cos(((2 * y + 1) * v * PI) / (2 * N));
        }
      }
      const cu = u === 0 ? 1 / Math.sqrt(2) : 1;
      const cv = v === 0 ? 1 / Math.sqrt(2) : 1;
      dct[u][v] = 0.25 * cu * cv * sum;
    }
  }
  return dct;
}

/**
 * Refined pHash function using a DCT.
 * Resizes the image to 32x32, converts to grayscale, computes the DCT,
 * extracts the top-left 8x8 block (excluding DC) and thresholds it to create a 64-bit hash.
 */
async function getImageHash(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', async () => {
        try {
          const buffer = Buffer.concat(chunks);
          const image = sharp(buffer)
            .greyscale()
            .resize(32, 32, { fit: 'fill' });
          const raw = await image.raw().toBuffer();
          const pixels = Array.from(raw);
          const N = 32;
          const matrix = [];
          for (let i = 0; i < N; i++) {
            matrix.push(pixels.slice(i * N, (i + 1) * N));
          }
          const dctMatrix = computeDCT(matrix, N);
          const blockSize = 8;
          const dctValues = [];
          for (let u = 0; u < blockSize; u++) {
            for (let v = 0; v < blockSize; v++) {
              dctValues.push(dctMatrix[u][v]);
            }
          }
          // Exclude the first term (DC coefficient) when calculating the average.
          const coeffs = dctValues.slice(1);
          const avg = coeffs.reduce((sum, val) => sum + val, 0) / coeffs.length;
          let hash = 0n;
          for (let i = 1; i < dctValues.length; i++) {
            if (dctValues[i] > avg) {
              hash |= 1n << BigInt(i - 1);
            }
          }
          resolve(hash.toString(16).padStart(16, '0'));
        } catch (error) {
          reject(error);
        }
      });
      response.on('error', (error) => reject(error));
    }).on('error', (error) => reject(error));
  });
}

// Check permissions for a text channel.
async function checkChannelPermissions(channel) {
  if (!channel) throw new Error('Channel is null.');
  // In v12, most channels are treated similarly.
  if (!channel.permissionsFor(client.user)) throw new Error('Cannot check permissions.');
  const required = ['VIEW_CHANNEL', 'READ_MESSAGE_HISTORY', 'SEND_MESSAGES'];
  const missing = required.filter(perm => !channel.permissionsFor(client.user).has(perm));
  if (missing.length) throw new Error(`Missing permissions: ${missing.join(', ')}`);
  return true;
}

// Process channel messages to detect duplicate images.
async function processMessages(channel, imageDatabase, context = '', statusMessage = null) {
  await checkChannelPermissions(channel);
  const processingStats = {
    startTime: Date.now(),
    processedImages: 0,
    duplicatesFound: 0,
    lastUpdateTime: Date.now(),
    updateInterval: 2000,
    currentGroup: 1
  };
  const destinationFolder = BOT_INFO.outputDir;
  await fsPromises.mkdir(destinationFolder, { recursive: true });
  let lastMessageId;
  const batchSize = 100;
  LOGGING_UTILS.logEnhanced({
    type: 'PROCESSING_START',
    data: {
      context,
      channelName: channel.name,
      channelId: channel.id,
      startTime: getCurrentFormattedTime(),
      outputDir: destinationFolder
    }
  });
  
  async function updateStatus() {
    const elapsedSeconds = (Date.now() - processingStats.startTime) / 1000;
    const elapsedMinutes = Math.floor(elapsedSeconds / 60);
    if (statusMessage) {
      statusMessage.edit(`Processing ${context}...\nImages: ${processingStats.processedImages}\nDuplicates: ${processingStats.duplicatesFound}\nGroups: ${processingStats.currentGroup - 1}\nElapsed: ${formatElapsedTime(elapsedSeconds)}\nOutput: ${destinationFolder}`);
    }
    LOGGING_UTILS.logEnhanced({
      type: 'PROCESSING_PROGRESS',
      data: {
        context,
        channelName: channel.name,
        processedImages: processingStats.processedImages,
        duplicatesFound: processingStats.duplicatesFound,
        elapsedTime: formatElapsedTime(elapsedSeconds),
        currentGroup: processingStats.currentGroup,
        outputDir: destinationFolder
      }
    });
  }
  
  while (true) {
    if (Date.now() - processingStats.lastUpdateTime > processingStats.updateInterval) {
      await updateStatus();
      processingStats.lastUpdateTime = Date.now();
    }
  
    const options = { limit: batchSize };
    if (lastMessageId) options.before = lastMessageId;
    const messages = await channel.messages.fetch(options);
    if (messages.size === 0) break;
  
    for (const msg of messages.values()) {
      // For each message, check attachments.
      msg.attachments.forEach(async attachment => {
        if (attachment.size > 20 * 1024 * 1024) {
          LOGGING_UTILS.logEnhanced({
            type: 'SKIP_LARGE_FILE',
            data: { file: attachment.name, size: attachment.size, messageId: msg.id }
          });
          return;
        }
        if (attachment.height) { // indicates an image
          processingStats.processedImages++;
          try {
            const hash = await getImageHash(attachment.url);
            if (imageDatabase.has(hash)) {
              processingStats.duplicatesFound++;
              const imageInfo = imageDatabase.get(hash);
              const groupPrefix = String(imageInfo.groupId).padStart(4, '0');
              if (imageInfo.duplicates.length === 0) {
                const origBase = path.parse(imageInfo.originalMessage.attachment.name).name;
                const origExt = path.parse(imageInfo.originalMessage.attachment.name).ext;
                let newOriginalName = `${groupPrefix}_ORIG_${origBase}${origExt}`;
                newOriginalName = getUniqueFilename(destinationFolder, newOriginalName);
                try {
                  await downloadImage(imageInfo.originalMessage.attachment.url, destinationFolder, newOriginalName);
                  imageInfo.originalNewName = newOriginalName;
                } catch (error) {
                  LOGGING_UTILS.logEnhanced({
                    type: 'ORIGINAL_SAVE_ERROR',
                    data: { error: error.message, url: imageInfo.originalMessage.attachment.url, groupId: imageInfo.groupId }
                  });
                }
              }
              const dupBase = path.parse(attachment.name).name;
              const dupExt = path.parse(attachment.name).ext;
              let newDupName = `${groupPrefix}_DUPE_${dupBase}${dupExt}`;
              newDupName = getUniqueFilename(destinationFolder, newDupName);
              try {
                await downloadImage(attachment.url, destinationFolder, newDupName);
                imageInfo.duplicates.push({
                  id: msg.id,
                  url: msg.url,
                  author: { username: msg.author.username, id: msg.author.id },
                  timestamp: msg.createdTimestamp,
                  location: context,
                  similarityScore: '100.00',
                  downloadedName: newDupName
                });
              } catch (error) {
                LOGGING_UTILS.logEnhanced({
                  type: 'DUPLICATE_SAVE_ERROR',
                  data: { error: error.message, url: attachment.url, groupId: imageInfo.groupId }
                });
              }
            } else {
              // New image group.
              imageDatabase.set(hash, {
                groupId: processingStats.currentGroup++,
                originalMessage: {
                  id: msg.id,
                  url: msg.url,
                  author: { username: msg.author.username, id: msg.author.id },
                  timestamp: msg.createdTimestamp,
                  location: context,
                  attachment: { url: attachment.url, name: attachment.name }
                },
                duplicates: []
              });
            }
          } catch (error) {
            LOGGING_UTILS.logEnhanced({
              type: 'IMAGE_PROCESSING_ERROR',
              data: { messageId: msg.id, url: attachment.url, error: error.message, context }
            });
          }
        }
      });
    }
    lastMessageId = messages.last().id;
  }
  
  return {
    processedImages: processingStats.processedImages,
    duplicatesFound: processingStats.duplicatesFound,
    groupsCreated: processingStats.currentGroup - 1
  };
}

// Generate CSV report.
async function generateReport(channelId, imageDatabase) {
  const timestamp = getCurrentFormattedTime();
  const fileName = `duplicate_report_${channelId}_${Date.now()}.csv`;
  const writeStream = fs.createWriteStream(path.join(BOT_INFO.outputDir, fileName));
  for (const [hash, imageInfo] of imageDatabase.entries()) {
    if (imageInfo.duplicates.length === 0) continue;
    const original = imageInfo.originalMessage;
    const reposts = imageInfo.duplicates;
    const groupPrefix = String(imageInfo.groupId).padStart(4, '0');
    const origDownloadName = imageInfo.originalNewName ||
      `${groupPrefix}_ORIG_${path.parse(original.attachment.name).name}${path.parse(original.attachment.name).ext}`;
    let stolenCount = 0, selfRepostCount = 0, totalSimilarity = 0;
    for (const rep of reposts) {
      if (rep.author.id === original.author.id) selfRepostCount++;
      else stolenCount++;
      totalSimilarity += parseFloat(rep.similarityScore);
    }
    const avgSimilarity = (totalSimilarity / reposts.length).toFixed(2);
    const uploadDate = new Date(original.timestamp).toISOString().split('T')[0];
    const dupNames = reposts.map(r => r.downloadedName).join(';');
    const line = [
      groupPrefix,
      original.url,
      original.author.username,
      original.location,
      uploadDate,
      reposts.length,
      reposts.map(r => r.author.username).join(';'),
      reposts.map(r => r.location).join(';'),
      stolenCount,
      selfRepostCount,
      avgSimilarity,
      BOT_INFO.outputDir,
      origDownloadName,
      dupNames
    ].join(',') + '\n';
    writeStream.write(line);
  }
  const headerText =
    `# Forum/Channel Analysis Report (pHash)\n` +
    `# Channel ID: ${channelId}\n` +
    `# Analysis by: ${BOT_INFO.operator}\n` +
    `# Analysis start: ${BOT_INFO.startTime} UTC\n` +
    `# Report generated: ${timestamp} UTC\n` +
    `# Bot version: ${BOT_INFO.version}\n` +
    `# Similarity threshold: ${BOT_INFO.similarityThreshold}\n` +
    `# Output directory: ${BOT_INFO.outputDir}\n\n` +
    'Group ID,Original Post URL,Original Poster,Original Location,Upload Date,' +
    'Number of Duplicates,Users Who Reposted,Locations,Stolen Reposts,Self-Reposts,Average Similarity,Local Path,Original Filename,Duplicate Filenames\n';
  writeStream.write(headerText);
  await new Promise(resolve => writeStream.end(resolve));
  return fileName;
}

// Command handler for messages.
client.on('message', async message => {
  if (message.author.bot) return;
  
  // !checkperms command check permissions.
  if (message.content.startsWith('!checkperms')) {
    const args = message.content.split(' ');
    const channelId = args[1];
    if (!channelId) return message.reply('Usage: !checkperms <channelId>');
    try {
      const channel = client.channels.get(channelId);
      if (!channel) return message.reply('Channel not found.');
      const perms = channel.permissionsFor(client.user);
      if (!perms) return message.reply('Cannot check permissions.');
      const required = ['VIEW_CHANNEL', 'READ_MESSAGE_HISTORY', 'SEND_MESSAGES'];
      const status = required.map(perm => `${perm}: ${perms.has(perm) ? '✅' : '❌'}`).join('\n');
      message.reply(`Bot permissions in channel:\n${status}`);
    } catch (error) {
      message.reply(`Error: ${error.message}`);
    }
  }
  
  // !check command starts analysis.
  if (message.content.startsWith('!check')) {
    const args = message.content.split(' ');
    const channelId = args[1];
    if (!channelId) return message.reply('Usage: !check <channelId>');
    handleCheckCommand(message, channelId);
  }
  
  if (message.content === '!help') {
    const helpMsg = `
**Forum/Channel Image Analyzer Bot (pHash Edition) Commands for Discord.js v12:**
• \`!check <channelId>\` - Analyze a channel for duplicate images using pHash.
• \`!checkperms <channelId>\` - Check bot permissions in a channel.
• \`!help\` - Show this help message.

**Notes:**
- Images are processed and compared using a refined pHash (DCT) algorithm.
- Originals are saved as: ****_ORIG_filename
- Duplicates are saved as: ****_DUPE_filename
`;
    message.reply(helpMsg);
  }
});
  
// Main command to run analysis.
async function handleCheckCommand(message, channelId) {
  const commandStartTime = Date.now();
  let statusMessage;
  try {
    const channel = client.channels.get(channelId);
    if (!channel) throw new Error('Channel not found.');
    
    statusMessage = await message.reply('Starting pHash analysis. This might take a while...');
    await fsPromises.mkdir(BOT_INFO.outputDir, { recursive: true });
    LOGGING_UTILS.logEnhanced({
      type: 'ANALYSIS_START',
      data: {
        channelId,
        channelName: channel.name,
        startTime: getCurrentFormattedTime(),
        outputDir: BOT_INFO.outputDir
      }
    });
    
    const results = await processMessages(channel, imageDatabase, `channel-${channel.name}`, statusMessage);
    const reportFile = await generateReport(channelId, imageDatabase);
    const elapsedTime = formatElapsedTime((Date.now() - commandStartTime) / 1000);
    
    statusMessage.edit(`pHash Analysis complete!
Channel: ${channel.name}
Images analyzed: ${results.processedImages.toLocaleString()}
Duplicates found: ${results.duplicatesFound.toLocaleString()}
Groups created: ${results.groupsCreated.toLocaleString()}
Time taken: ${elapsedTime}
Output directory: ${BOT_INFO.outputDir}
Report file: ${reportFile}`);
    
    LOGGING_UTILS.logEnhanced({
      type: 'ANALYSIS_COMPLETE',
      data: {
        channelId,
        channelName: channel.name,
        results,
        elapsedTime,
        outputDir: BOT_INFO.outputDir,
        reportFile
      }
    });
  } catch (error) {
    LOGGING_UTILS.logEnhanced({
      type: 'COMMAND_ERROR',
      data: { error: error.message }
    });
    if (statusMessage) statusMessage.edit(`Error during analysis: ${error.message}`);
    else message.reply(`Error during analysis: ${error.message}`);
  }
}

// Error handling.
client.on('error', error => {
  LOGGING_UTILS.logEnhanced({
    type: 'DISCORD_ERROR',
    data: { error: error.message }
  });
});

process.on('unhandledRejection', error => {
  LOGGING_UTILS.logEnhanced({
    type: 'UNHANDLED_REJECTION',
    data: { error: error.message }
  });
});

client.login(process.env.DISCORD_BOT_TOKEN)
  .then(() => {
    LOGGING_UTILS.logEnhanced({
      type: 'BOT_LOGIN_SUCCESS',
      data: { username: client.user.tag, startTime: BOT_INFO.startTime }
    });
    console.log(`Bot is ready! Logged in as ${client.user.tag}`);
  })
  .catch(error => {
    LOGGING_UTILS.logEnhanced({
      type: 'BOT_LOGIN_ERROR',
      data: { error: error.message }
    });
    process.exit(1);
});