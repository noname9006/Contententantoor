const { Client, Events, GatewayIntentBits, PermissionsBitField, EmbedBuilder } = require('discord.js');
const fs = require('fs');
const { imageHash } = require('image-hash');
const https = require('https');
const path = require('path');
require('dotenv').config();

// Bot information
const BOT_INFO = {
    startTime: new Date().toISOString().replace('T', ' ').split('.')[0],
    operator: 'noname9006',
    memoryLimit: 800 // MB
};

// Logging configuration
const LOG_CONFIG = {
    logDir: 'logs',
    logFile: `bot_log_${new Date().toISOString().split('T')[0]}.log`
};
const LOG_EVENTS = {
    HASH_COMMAND: 'HASH_COMMAND_RECEIVED',
    HASH_START: 'HASH_CREATION_START',
    HASH_PROGRESS: 'HASH_CREATION_PROGRESS',
    HASH_FINISH: 'HASH_CREATION_FINISH',
    HASH_EXPORT: 'HASH_EXPORT',
    NEW_IMAGE: 'NEW_IMAGE_DETECTED',
    NEW_HASH: 'NEW_HASH_CREATED',
    HASH_COMPARED: 'HASH_COMPARED',
    DUPLICATE_FOUND: 'DUPLICATE_FOUND'
};

// Create logs directory if it doesn't exist
if (!fs.existsSync(LOG_CONFIG.logDir)) {
    fs.mkdirSync(LOG_CONFIG.logDir);
}

// Retrieve tracked channels from environment variables (comma-separated list)
const TRACKED_CHANNELS = process.env.TRACKED_CHANNELS 
    ? process.env.TRACKED_CHANNELS.split(',').map(channelId => channelId.trim())
    : [];

// Initialize the client with proper intents
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ]
});

// ----------------------
// Utility Functions
// ----------------------

/**
 * Checks if the attachment's file extension and MIME type match the expected mapping.
 * Supported extensions and MIME types:
 *  - .jpg/.jpeg: image/jpeg
 *  - .png: image/png
 *  - .webp: image/webp
 * GIF images are not supported.
 *
 * Note: The URL is parsed to remove any query parameters before extracting the extension.
 */
function isSupportedImage(attachment) {
    // Parse the URL to get the pathname without query parameters.
    const parsedUrl = new URL(attachment.url);
    const ext = path.extname(parsedUrl.pathname).toLowerCase();
    // Do not process GIF images.
    if (ext === '.gif') {
        return false;
    }
    const supportedMappings = {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.webp': 'image/webp'
    };
    const expectedMime = supportedMappings[ext];
    // If we have an expected mime type from the extension and it matches the attachment's contentType, return true.
    if (expectedMime && expectedMime === attachment.contentType) {
        return true;
    }
    return false;
}

/**
 * Loads the hash database (a Map) from a file for a given channel.
 */
function loadHashDatabase(channelId) {
    const filePath = `hashtable_${channelId}.json`;
    if (fs.existsSync(filePath)) {
        try {
            const data = fs.readFileSync(filePath);
            const jsonData = JSON.parse(data);
            return new Map(Object.entries(jsonData));
        } catch (err) {
            logMessage('LOAD_ERROR', { error: err.message });
            return new Map();
        }
    } else {
        return new Map();
    }
}

/**
 * Saves the in-memory hash database (Map) to a file for a given channel.
 */
function saveHashDatabase(channelId, hashDB) {
    const filePath = `hashtable_${channelId}.json`;
    const obj = Object.fromEntries(hashDB);
    fs.writeFileSync(filePath, JSON.stringify(obj, null, 2));
}

/**
 * Formats elapsed time (in seconds) into HH:MM:SS or MM:SS.
 */
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

/**
 * Returns the current formatted time.
 */
function getCurrentFormattedTime() {
    return new Date().toISOString().replace('T', ' ').split('.')[0];
}

/**
 * Logs a message to console and appends it to a log file.
 */
function logMessage(type, content, elapsedTime = null) {
    const timestamp = new Date().toISOString();
    const logMsg = `[${timestamp}] ${type}: ${JSON.stringify(content)}${elapsedTime ? ` | Elapsed Time: ${elapsedTime}` : ''}\n`;
    console.log(logMsg.trim());
    fs.appendFileSync(path.join(LOG_CONFIG.logDir, LOG_CONFIG.logFile), logMsg);
}

/**
 * Checks memory usage.
 */
function checkMemoryUsage() {
    const used = process.memoryUsage();
    const memoryUsageMB = Math.round(used.heapUsed / 1024 / 1024);
    if (memoryUsageMB > (BOT_INFO.memoryLimit * 0.8)) {
        logMessage('MEMORY_WARNING', {
            currentUsageMB: memoryUsageMB,
            limitMB: BOT_INFO.memoryLimit
        });
    }
    return memoryUsageMB;
}

/**
 * Downloads an image and calculates its pHash.
 * Assumes that unsupported file types are filtered out beforehand.
 */
async function getImageHash(url) {
    return new Promise((resolve, reject) => {
        imageHash(url, 16, true, (error, data) => {
            if (error) {
                reject(error);
            } else {
                resolve(data);
            }
        });
    });
}

/**
 * Checks for required channel permissions.
 */
async function checkChannelPermissions(channel) {
    if (!channel) {
        throw new Error('Channel object is null or undefined');
    }
    if (!channel.isTextBased() && !channel.isThread() && channel.type !== 15) {
        throw new Error('This channel is not a text channel, thread, or forum');
    }
    const permissions = channel.permissionsFor(client.user);
    if (!permissions) {
        throw new Error('Cannot check permissions for this channel');
    }
    const requiredPermissions = ['ViewChannel', 'ReadMessageHistory', 'SendMessages'];
    const missingPermissions = requiredPermissions.filter(perm => !permissions.has(perm));
    if (missingPermissions.length > 0) {
        throw new Error(`Missing required permissions: ${missingPermissions.join(', ')}`);
    }
    return true;
}

/**
 * Counts total messages in a channel (or thread).
 */
async function countTotalMessages(channel) {
    await checkChannelPermissions(channel);
    let totalMessages = 0;
    let lastMessageId;
    const batchSize = 100;
    try {
        while (true) {
            const options = { limit: batchSize };
            if (lastMessageId) options.before = lastMessageId;
            const messages = await channel.messages.fetch(options);
            if (!messages || messages.size === 0) break;
            totalMessages += messages.size;
            lastMessageId = messages.last()?.id;
            messages.clear();
            if (global.gc) global.gc();
        }
        return totalMessages;
    } catch (error) {
        throw new Error(`Failed to count messages: ${error.message}`);
    }
}

/**
 * Retrieves all forum posts (active & archived) from a channel.
 */
async function getAllForumPosts(channel) {
    if (channel.type !== 15) {
        throw new Error('This is not a forum channel');
    }
    try {
        const activePosts = await channel.threads.fetchActive();
        const archivedPosts = await channel.threads.fetchArchived();
        return {
            active: Array.from(activePosts.threads.values()),
            archived: Array.from(archivedPosts.threads.values())
        };
    } catch (error) {
        throw new Error(`Failed to fetch forum posts: ${error.message}`);
    }
}

/**
 * Processes messages in a channel to update the image database.
 * Skips processing images that are unsupported due to file extension/MIME type mismatches.
 */
async function processMessages(channel, imageDatabase, context = '') {
    await checkChannelPermissions(channel);
    let processedImages = 0;
    let duplicatesFound = 0;
    let lastMessageId;
    const batchSize = 100;
    while (true) {
        const currentMemory = checkMemoryUsage();
        if (currentMemory > (BOT_INFO.memoryLimit * 0.8) && global.gc) {
            global.gc();
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        const options = { limit: batchSize };
        if (lastMessageId) options.before = lastMessageId;
        const messages = await channel.messages.fetch(options);
        if (messages.size === 0) break;
        for (const msg of messages.values()) {
            const attachments = [...msg.attachments.values()];
            for (const attachment of attachments) {
                if (attachment.contentType?.startsWith('image/')) {
                    if (!isSupportedImage(attachment)) {
                        logMessage('IMAGE_PROCESSING_ERROR', {
                            messageId: msg.id,
                            attachmentUrl: attachment.url,
                            error: `Unsupported file type or MIME mismatch: ext: ${path.extname(new URL(attachment.url).pathname).toLowerCase()} / mime: ${attachment.contentType}`
                        });
                        continue;
                    }
                    processedImages++;
                    try {
                        const hash = await getImageHash(attachment.url);
                        if (!imageDatabase.has(hash)) {
                            imageDatabase.set(hash, {
                                originalMessage: {
                                    id: msg.id,
                                    url: msg.url,
                                    author: {
                                        username: msg.author.username,
                                        id: msg.author.id
                                    },
                                    timestamp: msg.createdTimestamp,
                                    location: context
                                },
                                duplicates: []
                            });
                        } else {
                            duplicatesFound++;
                            imageDatabase.get(hash).duplicates.push({
                                id: msg.id,
                                url: msg.url,
                                author: {
                                    username: msg.author.username,
                                    id: msg.author.id
                                },
                                timestamp: msg.createdTimestamp,
                                location: context
                            });
                        }
                    } catch (error) {
                        logMessage('IMAGE_PROCESSING_ERROR', {
                            messageId: msg.id,
                            attachmentUrl: attachment.url,
                            error: error.message
                        });
                    }
                }
            }
        }
        lastMessageId = messages.last().id;
        messages.clear();
    }
    return { processedImages, duplicatesFound };
}

/**
 * Generates a CSV report of duplicate images.
 */
async function generateReport(channelId, imageDatabase) {
    const fileName = `duplicate_report_${channelId}_${Date.now()}.csv`;
    const writeStream = fs.createWriteStream(fileName);
    writeStream.write(
        `# Forum Analysis Report\n` +
        `# Channel ID: ${channelId}\n` +
        `# Analysis performed by: ${BOT_INFO.operator}\n` +
        `# Analysis start time: ${BOT_INFO.startTime} UTC\n` +
        `# Report generated at: ${getCurrentFormattedTime()} UTC\n\n` +
        'Original Post URL,Original Poster,Original Location,Upload Date,Number of Duplicates,Users Who Reposted,Locations of Reposts,Stolen Reposts,Self-Reposts\n'
    );
    for (const [hash, imageInfo] of imageDatabase.entries()) {
        const allPosters = [imageInfo.originalMessage, ...imageInfo.duplicates];
        allPosters.sort((a, b) => a.timestamp - b.timestamp);
        const originalPoster = allPosters[0];
        const reposts = allPosters.slice(1);
        let stolenCount = 0;
        let selfRepostCount = 0;
        for (const repost of reposts) {
            if (repost.author.id === originalPoster.author.id) {
                selfRepostCount++;
            } else {
                stolenCount++;
            }
        }
        const uploadDate = new Date(originalPoster.timestamp).toISOString().split('T')[0];
        const line = [
            originalPoster.url,
            originalPoster.author.username,
            originalPoster.location,
            uploadDate,
            reposts.length,
            reposts.map(d => d.author.username).join(';'),
            reposts.map(d => d.location).join(';'),
            stolenCount,
            selfRepostCount
        ].join(',') + '\n';
        writeStream.write(line);
    }
    await new Promise(resolve => writeStream.end(resolve));
    return fileName;
}

/**
 * Builds the hash database by scanning prior messages in a channel.
 * Skips processing images that are unsupported.
 */
async function buildHashDatabaseForChannel(channel) {
    let hashDB = new Map();
    let lastMessageId;
    const batchSize = 100;
    while (true) {
        const options = { limit: batchSize };
        if (lastMessageId) options.before = lastMessageId;
        const messages = await channel.messages.fetch(options);
        if (messages.size === 0) break;
        for (const msg of messages.values()) {
            const attachments = [...msg.attachments.values()];
            for (const attachment of attachments) {
                if (attachment.contentType && attachment.contentType.startsWith('image/')) {
                    if (!isSupportedImage(attachment)) {
                        logMessage('IMAGE_PROCESSING_ERROR', {
                            messageId: msg.id,
                            attachmentUrl: attachment.url,
                            error: `Unsupported file type or MIME mismatch: ext: ${path.extname(new URL(attachment.url).pathname).toLowerCase()} / mime: ${attachment.contentType}`
                        });
                        continue;
                    }
                    try {
                        const hash = await getImageHash(attachment.url);
                        if (!hashDB.has(hash)) {
                            hashDB.set(hash, {
                                originalMessage: {
                                    id: msg.id,
                                    url: msg.url,
                                    author: {
                                        username: msg.author.username,
                                        id: msg.author.id
                                    },
                                    timestamp: msg.createdTimestamp,
                                    channelId: msg.channel.id
                                },
                                duplicates: []
                            });
                        } else {
                            hashDB.get(hash).duplicates.push({
                                id: msg.id,
                                url: msg.url,
                                author: {
                                    username: msg.author.username,
                                    id: msg.author.id
                                },
                                timestamp: msg.createdTimestamp,
                                channelId: msg.channel.id
                            });
                        }
                    } catch (err) {
                        logMessage('IMAGE_PROCESSING_ERROR', {
                            messageId: msg.id,
                            attachmentUrl: attachment.url,
                            error: err.message
                        });
                    }
                }
            }
        }
        lastMessageId = messages.last().id;
    }
    return hashDB;
}

/**
 * Handles the forum analysis command (!check) for older messages.
 */
async function handleCheckCommand(message, channelId) {
    const commandStartTime = Date.now();
    let statusMessage = null;
    try {
        if (!channelId.match(/^\d+$/)) {
            throw new Error('Invalid channel ID format');
        }
        let channel;
        try {
            channel = await client.channels.fetch(channelId);
            if (!channel) throw new Error('Channel not found');
            if (channel.type !== 15) throw new Error('This channel is not a forum channel');
        } catch (error) {
            throw new Error(`Failed to access channel: ${error.message}`);
        }
        statusMessage = await message.reply('Starting forum analysis... This might take a while.');
        const { active: activePosts, archived: archivedPosts } = await getAllForumPosts(channel);
        const allPosts = [...activePosts, ...archivedPosts];
        let totalMessages = 0;
        for (const post of allPosts) {
            totalMessages += await countTotalMessages(post);
        }
        await statusMessage.edit(
            `Starting analysis of ${totalMessages.toLocaleString()} total messages across ${allPosts.length} forum posts...`
        );
        const imageDatabase = new Map();
        if (global.gc) global.gc();
        let processedImages = 0;
        let duplicatesFound = 0;
        let startTime = Date.now();
        for (const post of allPosts) {
            const postResults = await processMessages(post, imageDatabase, `forum-post-${post.name}`);
            processedImages += postResults.processedImages;
            duplicatesFound += postResults.duplicatesFound;
            const elapsedMinutes = Math.floor((Date.now() - startTime) / 60000);
            await statusMessage.edit(
                `Processing... Found ${processedImages} images (${duplicatesFound} duplicates)\n` +
                `Time elapsed: ${elapsedMinutes} minutes\n` +
                `Currently processing: ${post.name}`
            );
        }
        const reportFile = await generateReport(channelId, imageDatabase);
        const elapsedTime = formatElapsedTime((Date.now() - commandStartTime) / 1000);
        const finalStats = {
            totalMessages,
            processedImages,
            duplicatesFound,
            postsAnalyzed: allPosts.length,
            elapsedTime,
            memoryUsed: `${checkMemoryUsage()}MB`
        };
        logMessage('ANALYSIS_COMPLETE', finalStats);
        await statusMessage.edit({
            content: `Analysis complete!
Total messages analyzed: ${totalMessages.toLocaleString()}
Images found: ${processedImages.toLocaleString()}
Duplicates found: ${duplicatesFound.toLocaleString()}
Forum posts analyzed: ${allPosts.length}
Time taken: ${elapsedTime}
Report saved as: ${reportFile}`,
            files: [reportFile]
        });
    } catch (error) {
        logMessage('ERROR', {
            error: error.message,
            stack: error.stack,
            channelId
        });
        const errorMessage = `An error occurred: ${error.message}`;
        if (statusMessage) {
            await statusMessage.edit(errorMessage);
        } else {
            await message.reply(errorMessage);
        }
    }
}

// ----------------------
// Real-Time Image Tracking and Duplicate Reporting
// ----------------------

// In-memory hash tables for tracked channels (populated on startup)
const channelHashTables = {};

// On startup, load the most recent hashtable file for each tracked channel.
client.once('ready', () => {
    console.log(`Bot is ready! Logged in as ${client.user.tag}`);
    if (TRACKED_CHANNELS.length === 0) {
        console.log('No tracked channels configured in TRACKED_CHANNELS environment variable.');
    } else {
        TRACKED_CHANNELS.forEach(channelId => {
            channelHashTables[channelId] = loadHashDatabase(channelId);
            console.log(`Loaded hashtable for tracked channel ${channelId}: ${channelHashTables[channelId].size} entries`);
        });
    }
});

// Real-time tracking: Listen for messages containing image attachments in tracked channels.
client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot || message.content.startsWith('!')) return;
    if (TRACKED_CHANNELS.length > 0 && !TRACKED_CHANNELS.includes(message.channel.id)) {
        return;
    }
    const attachments = [...message.attachments.values()];
    const containsImage = attachments.some(att => att.contentType && att.contentType.startsWith('image/'));
    if (!containsImage) return;
    let hashDB = loadHashDatabase(message.channel.id);
    for (const attachment of attachments) {
        if (attachment.contentType && attachment.contentType.startsWith('image/')) {
            if (!isSupportedImage(attachment)) {
                logMessage('IMAGE_PROCESSING_ERROR', {
                    messageId: message.id,
                    attachmentUrl: attachment.url,
                    error: `Unsupported file type or MIME mismatch: ext: ${path.extname(new URL(attachment.url).pathname).toLowerCase()} / mime: ${attachment.contentType}`
                });
                continue;
            }
            try {
                const hash = await getImageHash(attachment.url);
                if (!hashDB.has(hash)) {
                    hashDB.set(hash, {
                        originalMessage: {
                            id: message.id,
                            url: message.url,
                            author: {
                                username: message.author.username,
                                id: message.author.id
                            },
                            timestamp: message.createdTimestamp,
                            channelId: message.channel.id
                        },
                        duplicates: []
                    });
                } else {
                    const entry = hashDB.get(hash);
                    let originalMsg;
                    try {
                        originalMsg = await message.channel.messages.fetch(entry.originalMessage.id);
                    } catch (err) {
                        originalMsg = null;
                    }
                    if (originalMsg) {
                        const isSelfRepost = entry.originalMessage.author.id === message.author.id;
                        const embed = new EmbedBuilder()
                            .setTitle(isSelfRepost ? 'SELF-REPOST' : 'DUPE')
                            .setDescription(`[Original message](${entry.originalMessage.url})`)
                            .setColor(isSelfRepost ? 0xFFA500 : 0xFF0000)
                            .setTimestamp();
                        await message.reply({ embeds: [embed] });
                    }
                    entry.duplicates.push({
                        id: message.id,
                        url: message.url,
                        author: {
                            username: message.author.username,
                            id: message.author.id
                        },
                        timestamp: message.createdTimestamp,
                        channelId: message.channel.id
                    });
                }
            } catch (err) {
                logMessage('IMAGE_PROCESSING_ERROR', {
                    messageId: message.id,
                    attachmentUrl: attachment.url,
                    error: err.message
                });
            }
        }
    }
    saveHashDatabase(message.channel.id, hashDB);
    channelHashTables[message.channel.id] = hashDB;
});

// ----------------------
// Command Handlers
// ----------------------

// Build hash database from previous messages.
client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;
    if (message.content.startsWith('!hash')) {
        logMessage(LOG_EVENTS.HASH_COMMAND, { content: message.content });
        const args = message.content.split(' ');
        const channelId = args[1];
        if (!channelId) {
            return message.reply('Please provide a channel ID. Usage: !hash <channel_id>');
        }
        try {
            const channel = await client.channels.fetch(channelId);
            if (!channel) return message.reply('Channel not found');
            await checkChannelPermissions(channel);
            logMessage(LOG_EVENTS.HASH_START, { channelId });
            const statusMessage = await message.reply('Starting to build hash database...');
            const hashDB = await buildHashDatabaseForChannel(channel);
            saveHashDatabase(channelId, hashDB);
            logMessage(LOG_EVENTS.HASH_FINISH, { channelId, totalImages: hashDB.size });
            await statusMessage.edit(`Hash database built for channel ${channelId}. Processed ${hashDB.size} unique images.`);
            logMessage(LOG_EVENTS.HASH_EXPORT, { channelId, filename: `hashtable_${channelId}.json` });
        } catch (error) {
            logMessage('ERROR', { error: error.message, channelId });
            message.reply(`Error building hash database: ${error.message}`);
        }
    }
});

// Command to check forum analysis (!check command).
client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;
    if (message.content.startsWith('!check')) {
        const channelId = message.content.split(' ')[1];
        if (!channelId) {
            return message.reply('Please provide a forum channel ID. Usage: !check <channelId>');
        }
        await handleCheckCommand(message, channelId);
    }
});

// Command to check channel permissions.
client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;
    if (message.content.startsWith('!checkperms')) {
        const channelId = message.content.split(' ')[1];
        if (!channelId) {
            return message.reply('Please provide a channel ID. Usage: !checkperms <channelId>');
        }
        try {
            const channel = await client.channels.fetch(channelId);
            if (!channel) return message.reply('Channel not found');
            if (channel.type !== 15) {
                return message.reply('This is not a forum channel. This bot only works with forum channels.');
            }
            const permissions = channel.permissionsFor(client.user);
            if (!permissions) return message.reply('Cannot check permissions for this channel');
            const permissionList = ['ViewChannel', 'ReadMessageHistory', 'SendMessages'];
            const permissionStatus = permissionList.map(perm => `${perm}: ${permissions.has(perm) ? '✅' : '❌'}`).join('\n');
            message.reply(`Bot permissions in forum channel:\n${permissionStatus}`);
        } catch (error) {
            message.reply(`Error checking permissions: ${error.message}`);
        }
    }
});

// Help command.
client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;
    if (message.content === '!help') {
        const helpMessage = `
**Forum Image Analyzer Bot Commands:**
\`!check <channelId>\` - Analyze a forum channel for duplicate images
\`!checkperms <channelId>\` - Check bot permissions in a forum channel
\`!hash <channelId>\` - Build hash database for previous messages in a channel
\`!help\` - Show this help message

**Real-Time Tracking:**
Once the bot is launched, it loads hashtable files for tracked channels specified in the TRACKED_CHANNELS environment variable.
Any new message in a tracked channel with an image attachment is processed:
- If the image hash already exists, the bot replies with an embedded message indicating either SELF-REPOST or DUPE (with a link to the original message).
- Otherwise, the image gets added to the hash database.
Unsupported images (due to MIME type and extension mismatches, or GIFs) are skipped.
`;
        message.reply(helpMessage);
    }
});

// ----------------------
// Error Handling
// ----------------------
client.on(Events.Error, error => {
    logMessage('DISCORD_ERROR', { error: error.message, stack: error.stack });
});

process.on('unhandledRejection', error => {
    logMessage('UNHANDLED_REJECTION', { error: error.message, stack: error.stack });
});

process.on('uncaughtException', error => {
    logMessage('UNCAUGHT_EXCEPTION', { error: error.message, stack: error.stack });
    process.exit(1);
});

// ----------------------
// Bot Startup
// ----------------------
if (!process.env.DISCORD_BOT_TOKEN) {
    logMessage('STARTUP_ERROR', 'No Discord bot token found in environment variables!');
    process.exit(1);
}

client.login(process.env.DISCORD_BOT_TOKEN)
    .then(() => {
        logMessage('BOT_LOGIN_SUCCESS', {
            username: client.user.tag,
            startTime: BOT_INFO.startTime,
            operator: BOT_INFO.operator
        });
        console.log(`Bot is ready! Logged in as ${client.user.tag}`);
    })
    .catch(error => {
        logMessage('BOT_LOGIN_ERROR', { error: error.message, stack: error.stack });
        process.exit(1);
    });

// Export functions for testing if needed.
module.exports = {
    formatElapsedTime,
    getCurrentFormattedTime,
    getImageHash,
    countTotalMessages,
    getAllForumPosts,
    processMessages,
    generateReport,
    checkMemoryUsage,
    BOT_INFO,
    LOG_CONFIG
};