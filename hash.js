const { Client, Events, GatewayIntentBits, PermissionsBitField, EmbedBuilder } = require('discord.js');
const fs = require('fs');
const crypto = require('crypto');
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

// Initialize the client with proper intents
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ]
});

// In-memory image database for legacy functionality (forum analysis, etc)
const imageDatabase = new Map();

// --- New: File-based persistent hash database helpers --- //
/**
 * Loads the hash table from file for a given channel.
 * The file name is based on the channel id.
 */
function loadHashDatabase(channelId) {
    const filePath = `hashtable_${channelId}.json`;
    if (fs.existsSync(filePath)) {
        try {
            const data = fs.readFileSync(filePath);
            const jsonData = JSON.parse(data);
            // Convert plain object into a Map
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
    // To convert Map to a plain object, use Object.fromEntries.
    const obj = Object.fromEntries(hashDB);
    fs.writeFileSync(filePath, JSON.stringify(obj, null, 2));
}

// --- End File-based hash database helpers --- //

// Helper Functions (Preserved from original file)
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

function logMessage(type, content, elapsedTime = null) {
    const timestamp = new Date().toISOString();
    const logMsg = `[${timestamp}] ${type}: ${JSON.stringify(content)}${elapsedTime ? ` | Elapsed Time: ${elapsedTime}` : ''}\n`;
    
    console.log(logMsg.trim());
    fs.appendFileSync(path.join(LOG_CONFIG.logDir, LOG_CONFIG.logFile), logMsg);
}

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

// Function to download image and calculate its hash (Preserved)
async function getImageHash(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (response) => {
            const chunks = [];
            response.on('data', (chunk) => chunks.push(chunk));
            response.on('end', () => {
                const buffer = Buffer.concat(chunks);
                const hash = crypto.createHash('md5').update(buffer).digest('hex');
                resolve(hash);
            });
            response.on('error', (error) => reject(error));
        }).on('error', (error) => reject(error));
    });
}

// Function to check channel permissions (Preserved)
async function checkChannelPermissions(channel) {
    if (!channel) {
        throw new Error('Channel object is null or undefined');
    }

    // Check for forum channel type (15) or threads
    if (!channel.isTextBased() && !channel.isThread() && channel.type !== 15) {
        throw new Error('This channel is not a text channel, thread, or forum');
    }

    const permissions = channel.permissionsFor(client.user);
    if (!permissions) {
        throw new Error('Cannot check permissions for this channel');
    }

    const requiredPermissions = [
        'ViewChannel',
        'ReadMessageHistory',
        'SendMessages'
    ];

    const missingPermissions = requiredPermissions.filter(perm => !permissions.has(perm));
    if (missingPermissions.length > 0) {
        throw new Error(`Missing required permissions: ${missingPermissions.join(', ')}`);
    }

    return true;
}

// Function to count messages in a thread or channel (Preserved)
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

// Function to get all forum posts (Preserved)
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

// Function to process messages and find images (Preserved for forum analysis)
async function processMessages(channel, imageDatabase, context = '') {
    await checkChannelPermissions(channel);

    let processedImages = 0;
    let duplicatesFound = 0;
    let lastMessageId;
    const batchSize = 100;

    while (true) {
        const currentMemory = checkMemoryUsage();
        
        if (currentMemory > (BOT_INFO.memoryLimit * 0.8)) {
            if (global.gc) {
                global.gc();
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }

        const options = { limit: batchSize };
        if (lastMessageId) options.before = lastMessageId;
        
        const messages = await channel.messages.fetch(options);
        if (messages.size === 0) break;

        for (const msg of messages.values()) {
            const attachments = [...msg.attachments.values()];
            
            for (const attachment of attachments) {
                if (attachment.contentType?.startsWith('image/')) {
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

// Function to generate CSV report (Preserved)
async function generateReport(channelId, imageDatabase) {
    const fileName = `duplicate_report_${channelId}_${Date.now()}.csv`;
    const writeStream = fs.createWriteStream(fileName);

    // Write header
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

// Main command handler for forum analysis (Preserved)
async function handleCheckCommand(message, channelId) {
    const commandStartTime = Date.now();
    let statusMessage = null;
    
    try {
        const initialMemory = checkMemoryUsage();
        
        if (!channelId.match(/^\d+$/)) {
            throw new Error('Invalid channel ID format');
        }

        let channel;
        try {
            channel = await client.channels.fetch(channelId);
            if (!channel) {
                throw new Error('Channel not found');
            }
            
            if (channel.type !== 15) {
                throw new Error('This channel is not a forum');
            }
            
        } catch (error) {
            throw new Error(`Failed to access channel: ${error.message}`);
        }

        statusMessage = await message.reply('Starting forum analysis... This might take a while.');
        
        // Get all forum posts
        const { active: activePosts, archived: archivedPosts } = await getAllForumPosts(channel);
        const allPosts = [...activePosts, ...archivedPosts];
        
        let totalMessages = 0;
        for (const post of allPosts) {
            totalMessages += await countTotalMessages(post);
        }

        await statusMessage.edit(
            `Starting analysis of ${totalMessages.toLocaleString()} total messages ` +
            `across ${allPosts.length} forum posts (${activePosts.length} active, ${archivedPosts.length} archived)...`
        );

        // Clear previous data and run garbage collection
        imageDatabase.clear();
        if (global.gc) {
            global.gc();
        }

        let processedImages = 0;
        let duplicatesFound = 0;
        let startTime = Date.now();

        // Process each forum post
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

        // Generate report
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
            content: `Analysis complete!\n` +
                    `Total messages analyzed: ${totalMessages.toLocaleString()}\n` +
                    `Images found: ${processedImages.toLocaleString()}\n` +
                    `Duplicates found: ${duplicatesFound.toLocaleString()}\n` +
                    `Forum posts analyzed: ${allPosts.length}\n` +
                    `Time taken: ${elapsedTime}\n` +
                    `Report saved as: ${reportFile}`,
            files: [reportFile]
        });

    } catch (error) {
        logMessage('ERROR', {
            error: error.message,
            stack: error.stack,
            channelId: channelId
        });

        const errorMessage = `An error occurred: ${error.message}`;
        if (statusMessage) {
            await statusMessage.edit(errorMessage);
        } else {
            await message.reply(errorMessage);
        }
    }
}

// --- New: Real-time image tracking and duplicate reporting --- //

// Get the list of channel IDs to track from environment variables (comma separated)
const TRACKED_CHANNELS = process.env.TRACKED_CHANNELS ? process.env.TRACKED_CHANNELS.split(',') : [];

client.on(Events.MessageCreate, async message => {
    if (message.author.bot) return;
    
    // Add debug logging
    console.log(`Received message: ${message.content}`);
    
    if (message.content.startsWith('!hash')) {
        console.log('Hash command detected');
        const channelId = message.content.split(' ')[1];
        console.log(`Channel ID: ${channelId}`);
    }
});	
client.on(Events.MessageCreate, async message => {
    // Ignore bot messages and commands (starting with '!')
    if (message.author.bot) return;
    if (message.content.startsWith('!')) return;
    
    // Only process messages in tracked channels if TRACKED_CHANNELS is specified
    if (TRACKED_CHANNELS.length > 0 && !TRACKED_CHANNELS.includes(message.channel.id)) {
        return;
    }
    
    // Check if the message contains an image attachment.
    const attachments = [...message.attachments.values()];
    let containsImage = false;
    for (const attachment of attachments) {
        if (attachment.contentType && attachment.contentType.startsWith('image/')) {
            containsImage = true;
            break;
        }
    }
    if (!containsImage) return;
    
    // Load the current hash table for this channel from file.
    let hashDB = loadHashDatabase(message.channel.id);
    
    // Process each image attachment.
    for (const attachment of attachments) {
        if (attachment.contentType && attachment.contentType.startsWith('image/')) {
            try {
                const hash = await getImageHash(attachment.url);
                if (!hashDB.has(hash)) {
                    // No prior hash: store as original.
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
                    // Duplicate: retrieve original entry.
                    const entry = hashDB.get(hash);
                    // Verify if the original message is still present.
                    let originalMsg;
                    try {
                        originalMsg = await message.channel.messages.fetch(entry.originalMessage.id);
                    } catch (err) {
                        originalMsg = null;
                    }
                    
                    if (originalMsg) {
                        // Compare authors.
                        if (entry.originalMessage.author.id === message.author.id) {
                            // Self repost scenario.
                            const embed = new EmbedBuilder()
                                .setDescription("self repost")
                                .setColor(0xFFA500);
                            await message.reply({ embeds: [embed] });
                        } else {
                            // Different user duplicate.
                            const embed = new EmbedBuilder()
                                .setDescription(`dupe: [Original Post](${entry.originalMessage.url})`)
                                .setColor(0xFF0000);
                            await message.reply({ embeds: [embed] });
                        }
                    }
                    // Add this duplicate message to the entry.
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
    // Save the updated hash table to file.
    saveHashDatabase(message.channel.id, hashDB);
});

// Command handler for building hash database from previous messages.
client.on(Events.MessageCreate, async message => {
    if (message.author.bot) return;
    if (message.content.startsWith('!hash')) {
        const args = message.content.split(' ');
        const channelId = args[1];
        if (!channelId) {
            return message.reply('Please provide a channel ID. Usage: !hash <channel_id>');
        }
        try {
            const channel = await client.channels.fetch(channelId);
            if (!channel) return message.reply('Channel not found');
            await checkChannelPermissions(channel);
            // Build hash database from previous messages.
            const hashDB = await buildHashDatabaseForChannel(channel);
            saveHashDatabase(channelId, hashDB);
            message.reply(`Hash database built for channel ${channelId}. Processed ${hashDB.size} unique images.`);
        } catch (err) {
            message.reply(`Error building hash database: ${err.message}`);
        }
    }
});

client.on(Events.MessageCreate, async message => {
    if (message.author.bot) return;
    
    console.log(`Received message: ${message.content}`);
    
    if (message.content.startsWith('!hash')) {
        console.log('Hash command detected');
        const channelId = message.content.split(' ')[1];
        console.log(`Channel ID: ${channelId}`);
        
        try {
            // Log the hash command received
            logMessage(LOG_EVENTS.HASH_COMMAND, { channelId });
            
            // Fetch the channel
            const channel = await client.channels.fetch(channelId);
            if (!channel) {
                return message.reply('Channel not found');
            }

            // Check permissions
            await checkChannelPermissions(channel);
            
            // Log hash creation start
            logMessage(LOG_EVENTS.HASH_START, { channelId });
            
            // Send initial response
            const statusMessage = await message.reply('Starting to build hash database...');
            
            // Build hash database
            const hashDB = await buildHashDatabaseForChannel(channel);
            
            // Save the database
            saveHashDatabase(channelId, hashDB);
            
            // Log completion
            logMessage(LOG_EVENTS.HASH_FINISH, { 
                channelId,
                totalImages: hashDB.size 
            });
            
            // Update status message
            await statusMessage.edit(`Hash database built for channel ${channelId}. Processed ${hashDB.size} unique images.`);
            
            // Log export
            logMessage(LOG_EVENTS.HASH_EXPORT, {
                channelId,
                filename: `hashtable_${channelId}.json`
            });
            
        } catch (error) {
            logMessage('ERROR', {
                error: error.message,
                channelId
            });
            message.reply(`Error building hash database: ${error.message}`);
        }
    }
});

/**
 * Builds a hash database by scanning older messages in a channel.
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

// Existing command handler for checking channel permissions.
client.on(Events.MessageCreate, async message => {
    if (message.author.bot) return;

    if (message.content.startsWith('!checkperms')) {
        const channelId = message.content.split(' ')[1];
        if (!channelId) {
            return message.reply('Please provide a channel ID. Usage: !checkperms channelId');
        }

        try {
            const channel = await client.channels.fetch(channelId);
            if (!channel) {
                return message.reply('Channel not found');
            }

            if (channel.type !== 15) {
                return message.reply('This is not a forum channel. This bot only works with forum channels.');
            }

            const permissions = channel.permissionsFor(client.user);
            if (!permissions) {
                return message.reply('Cannot check permissions for this channel');
            }

            const permissionList = [
                'ViewChannel',
                'ReadMessageHistory',
                'SendMessages'
            ];

            const permissionStatus = permissionList.map(perm => 
                `${perm}: ${permissions.has(perm) ? '✅' : '❌'}`
            ).join('\n');

            message.reply(`Bot permissions in forum channel:\n${permissionStatus}`);
        } catch (error) {
            message.reply(`Error checking permissions: ${error.message}`);
        }
    }
});

// Main command handler for forum analysis command.
client.on(Events.MessageCreate, async message => {
    if (message.author.bot) return;

    if (message.content.startsWith('!check')) {
        const channelId = message.content.split(' ')[1];
        if (!channelId) {
            return message.reply('Please provide a forum channel ID. Usage: !check channelId');
        }
        
        await handleCheckCommand(message, channelId);
    }

    // Help command
    if (message.content === '!help') {
        const helpMessage = `
**Forum Image Analyzer Bot Commands:**
\`!check channelId\` - Analyze a forum channel for duplicate images
\`!checkperms channelId\` - Check bot permissions in a forum channel
\`!hash channelId\` - Build hash database for previous messages in a channel
\`!help\` - Show this help message

**How to use:**
1. Configure the tracked channels in your .env file (TRACKED_CHANNELS comma-separated).
2. To build a hash database, use \`!hash channelId\`.
3. New image messages will be processed to check for duplicate hash values.
4. If a duplicate image is detected, and the original message is present, you'll receive an embedded reply indicating either "self repost" or "dupe" with a link.
`;
        message.reply(helpMessage);
    }
});

// Error handling
client.on(Events.Error, error => {
    logMessage('DISCORD_ERROR', {
        error: error.message,
        stack: error.stack
    });
});

// Process error handling
process.on('unhandledRejection', error => {
    logMessage('UNHANDLED_REJECTION', {
        error: error.message,
        stack: error.stack
    });
});

process.on('uncaughtException', error => {
    logMessage('UNCAUGHT_EXCEPTION', {
        error: error.message,
        stack: error.stack
    });
    process.exit(1);
});

// Startup checks
if (!process.env.DISCORD_BOT_TOKEN) {
    logMessage('STARTUP_ERROR', 'No Discord bot token found in environment variables!');
    process.exit(1);
}

// Bot initialization
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
        logMessage('BOT_LOGIN_ERROR', {
            error: error.message,
            stack: error.stack
        });
        process.exit(1);
});

// Export for testing
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