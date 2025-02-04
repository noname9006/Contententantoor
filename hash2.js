const { Client, Events, GatewayIntentBits, Permissions } = require('discord.js');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');
const path = require('path');
require('dotenv').config();

// Helper function to format elapsed time
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

// Helper function to format current time in YYYY-MM-DD HH:MM:SS format
function getCurrentFormattedTime() {
    const now = new Date();
    return now.toISOString()
              .replace('T', ' ')
              .split('.')[0];
}

// Bot information
const BOT_INFO = {
    startTime: getCurrentFormattedTime(),
    operator: 'noname9006',
    memoryLimit: 800 // MB
};

// Logging configuration
const LOG_CONFIG = {
    logDir: 'logs',
    logFile: `bot_log_${new Date().toISOString().split('T')[0]}.log`
};

// Create logs directory if it doesn't exist
if (!fs.existsSync(LOG_CONFIG.logDir)) {
    fs.mkdirSync(LOG_CONFIG.logDir);
}

// Compact logging function
function logMessage(type, content, elapsedTime = null) {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${type}: ${JSON.stringify(content)}${elapsedTime ? ` | Elapsed Time: ${elapsedTime}` : ''}\n`;
    
    // Console output
    console.log(logMessage.trim());
    
    // File output
    fs.appendFileSync(path.join(LOG_CONFIG.logDir, LOG_CONFIG.logFile), logMessage);
}

// Memory monitoring function
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

// Create a new client instance
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.Threads
    ]
});

// Store image hashes and their metadata
const imageDatabase = new Map();

// Function to download image and calculate its hash
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
// Function to check channel permissions
async function checkChannelPermissions(channel) {
    if (!channel) {
        throw new Error('Channel object is null or undefined');
    }

    if (!channel.isTextBased()) {
        throw new Error('This is not a text channel or thread');
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

// Function to count total messages in a channel or thread
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

            // Free up memory
            messages.clear();
            if (global.gc) {
                global.gc();
            }
        }

        return totalMessages;
    } catch (error) {
        throw new Error(`Failed to count messages: ${error.message}`);
    }
}

// Function to get all threads in a channel
async function getAllThreads(channel) {
    if (!channel.threads) {
        return { active: [], archived: [] };
    }

    try {
        const activeThreads = await channel.threads.fetchActive();
        const archivedThreads = await channel.threads.fetchArchived();

        return {
            active: Array.from(activeThreads.threads.values()),
            archived: Array.from(archivedThreads.threads.values())
        };
    } catch (error) {
        throw new Error(`Failed to fetch threads: ${error.message}`);
    }
}

// Function to process messages and find images
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
// Function to generate CSV report
async function generateReport(channelId, imageDatabase) {
    const fileName = `duplicate_report_${channelId}_${Date.now()}.csv`;
    const writeStream = fs.createWriteStream(fileName);

    // Write header with detailed information
    writeStream.write(
        `# Analysis Report\n` +
        `# Channel ID: ${channelId}\n` +
        `# Analysis performed by: ${BOT_INFO.operator}\n` +
        `# Analysis start time: ${BOT_INFO.startTime} UTC\n` +
        `# Report generated at: ${getCurrentFormattedTime()} UTC\n\n` +
        'Original Message URL,Original Poster,Original Location,Upload Date,Number of Duplicates,Users Who Reposted,Locations of Reposts,Stolen Reposts,Self-Reposts\n'
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

// Command handler
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
            
            await checkChannelPermissions(channel);
            
        } catch (error) {
            throw new Error(`Failed to access channel: ${error.message}`);
        }

        statusMessage = await message.reply('Starting channel and thread analysis... This might take a while.');
        
        // Get all threads
        const { active: activeThreads, archived: archivedThreads } = await getAllThreads(channel);
        const allThreads = [...activeThreads, ...archivedThreads];
        
        // Count messages
        const mainChannelMessages = await countTotalMessages(channel);
        let threadMessages = 0;
        for (const thread of allThreads) {
            threadMessages += await countTotalMessages(thread);
        }
        
        const totalMessages = mainChannelMessages + threadMessages;

        await statusMessage.edit(
            `Starting analysis of ${totalMessages.toLocaleString()} total messages ` +
            `(${mainChannelMessages.toLocaleString()} in main channel, ${threadMessages.toLocaleString()} in ${allThreads.length} threads)...`
        );

        // Clear previous data and run garbage collection
        imageDatabase.clear();
        if (global.gc) {
            global.gc();
        }

        let processedMessages = 0;
        let processedImages = 0;
        let duplicatesFound = 0;
        let startTime = Date.now();
		// Process main channel
        const mainChannelResults = await processMessages(channel, imageDatabase, 'main-channel');
        processedImages += mainChannelResults.processedImages;
        duplicatesFound += mainChannelResults.duplicatesFound;

        // Process threads
        for (const thread of allThreads) {
            const threadResults = await processMessages(thread, imageDatabase, `thread-${thread.id}`);
            processedImages += threadResults.processedImages;
            duplicatesFound += threadResults.duplicatesFound;

            const elapsedMinutes = Math.floor((Date.now() - startTime) / 60000);
            await statusMessage.edit(
                `Processing... Found ${processedImages} images (${duplicatesFound} duplicates) ` +
                `Time elapsed: ${elapsedMinutes} minutes`
            );
        }

        // Generate report
        const reportFile = await generateReport(channelId, imageDatabase);
        const elapsedTime = formatElapsedTime((Date.now() - commandStartTime) / 1000);

        const finalStats = {
            totalMessages,
            processedImages,
            duplicatesFound,
            threadsAnalyzed: allThreads.length,
            elapsedTime,
            memoryUsed: `${checkMemoryUsage()}MB`
        };

        logMessage('ANALYSIS_COMPLETE', finalStats);

        await statusMessage.edit({
            content: `Analysis complete!\n` +
                    `Total messages analyzed: ${totalMessages.toLocaleString()}\n` +
                    `Images found: ${processedImages.toLocaleString()}\n` +
                    `Duplicates found: ${duplicatesFound.toLocaleString()}\n` +
                    `Threads analyzed: ${allThreads.length}\n` +
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

// Permission check command
client.on(Events.MessageCreate, async message => {
    if (message.author.bot) return;

    if (message.content.startsWith('!checkperms')) {
        const channelId = message.content.split(' ')[1];
        if (!channelId) {
            return message.reply('Please provide a channel ID. Usage: !checkperms <channelId>');
        }

        try {
            const channel = await client.channels.fetch(channelId);
            if (!channel) {
                return message.reply('Channel not found');
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

            message.reply(`Bot permissions in channel:\n${permissionStatus}`);
        } catch (error) {
            message.reply(`Error checking permissions: ${error.message}`);
        }
    }
});

// Main command handler
client.on(Events.MessageCreate, async message => {
    if (message.author.bot) return;

    if (message.content.startsWith('!check')) {
        const channelId = message.content.split(' ')[1];
        if (!channelId) {
            return message.reply('Please provide a channel ID. Usage: !check <channelId>');
        }
        
        await handleCheckCommand(message, channelId);
    }
});

// Error handling
client.on(Events.Error, error => {
    logMessage('DISCORD_ERROR', {
        error: error.message,
        stack: error.stack
    });
});

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

// Login check and initialization
if (!process.env.DISCORD_BOT_TOKEN) {
    logMessage('STARTUP_ERROR', 'No Discord bot token found in environment variables!');
    process.exit(1);
}

// Initialize bot
client.login(process.env.DISCORD_BOT_TOKEN)
    .then(() => {
        logMessage('BOT_LOGIN_SUCCESS', {
            username: client.user.tag,
            startTime: BOT_INFO.startTime
        });
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
    getAllThreads,
    processMessages,
    generateReport,
    checkMemoryUsage,
    BOT_INFO,
    LOG_CONFIG
};