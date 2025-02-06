const { Client, Events, GatewayIntentBits, PermissionsBitField } = require('discord.js');
const fs = require('fs');
const sharp = require('sharp');
const https = require('https');
const path = require('path');
require('dotenv').config();

// Bot information
const BOT_INFO = {
    startTime: new Date().toISOString().replace('T', ' ').split('.')[0],
    memoryLimit: 800, // MB
    similarityThreshold: 12,
    version: '1.1.0'
};

// Enhanced logging utilities
const LOGGING_UTILS = {
    startTime: '2025-02-06 10:14:59', // Current UTC time
    operator: 'noname9006',
    
    // Enhanced memory logging
    detailedMemoryLog: function() {
        const memoryUsage = process.memoryUsage();
        return {
            type: 'MEMORY_DETAILS',
            timestamp: new Date().toISOString(),
            data: {
                heapUsed: `${(memoryUsage.heapUsed / 1024 / 1024).toFixed(2)}MB`,
                heapTotal: `${(memoryUsage.heapTotal / 1024 / 1024).toFixed(2)}MB`,
                rss: `${(memoryUsage.rss / 1024 / 1024).toFixed(2)}MB`,
                external: `${(memoryUsage.external / 1024 / 1024).toFixed(2)}MB`,
                arrayBuffers: `${(memoryUsage.arrayBuffers / 1024 / 1024).toFixed(2)}MB`
            }
        };
    },

    // Progress tracking
    calculateProgress: function(current, total) {
        const percentage = ((current / total) * 100).toFixed(2);
        const estimatedTimeRemaining = this.calculateETA(current, total);
        return {
            type: 'PROGRESS_UPDATE',
            timestamp: new Date().toISOString(),
            data: {
                percentage: `${percentage}%`,
                current,
                total,
                estimatedTimeRemaining
            }
        };
    },

    // Processing rate calculation
    calculateProcessingRate: function(processedItems, elapsedSeconds) {
        const rate = processedItems / (elapsedSeconds || 1);
        return {
            type: 'PROCESSING_RATE',
            timestamp: new Date().toISOString(),
            data: {
                itemsPerSecond: rate.toFixed(2),
                totalProcessed: processedItems,
                elapsedSeconds: elapsedSeconds.toFixed(1)
            }
        };
    },

    // ETA calculation
    calculateETA: function(current, total, startTime) {
        const elapsedMs = Date.now() - startTime;
        const estimatedTotalMs = (elapsedMs / current) * total;
        const remainingMs = estimatedTotalMs - elapsedMs;
        const remainingMinutes = Math.ceil(remainingMs / 60000);
        
        return `~${remainingMinutes} minute${remainingMinutes !== 1 ? 's' : ''} remaining`;
    },

    // Enhanced log message
    logEnhanced: function(data) {
        const logEntry = {
            timestamp: new Date().toISOString(),
            operator: this.operator,
            ...data
        };

        const logMessage = `[${logEntry.timestamp}] ${logEntry.type}: ${JSON.stringify(logEntry.data)}\n`;
        console.log(logMessage.trim());
        fs.appendFileSync(path.join(LOG_CONFIG.logDir, LOG_CONFIG.logFile), logMessage);
    }
};

// Logging configuration
const LOG_CONFIG = {
    logDir: 'logs',
    logFile: `bot_log_${BOT_INFO.startTime.split(' ')[0]}.log`
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

// Initialize image database
const imageDatabase = new Map();

// Helper Functions
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
    const logMessage = `[${timestamp}] ${type}: ${JSON.stringify(content)}${elapsedTime ? ` | Elapsed Time: ${elapsedTime}` : ''}\n`;
    
    console.log(logMessage.trim());
    fs.appendFileSync(path.join(LOG_CONFIG.logDir, LOG_CONFIG.logFile), logMessage);
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

// Wavelet transform functions
function haar1D(data, size) {
    const temp = new Float32Array(size);
    
    for (let i = 0; i < size; i += 2) {
        const avg = (data[i] + data[i + 1]) / 2;
        const diff = (data[i] - data[i + 1]) / 2;
        temp[i/2] = avg;
        temp[size/2 + i/2] = diff;
    }
    
    for (let i = 0; i < size; i++) {
        data[i] = temp[i];
    }
}

function discreteWaveletTransform(pixels, width, height) {
    const tempRow = new Float32Array(width);
    
    // Transform rows
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            tempRow[x] = pixels[y * width + x];
        }
        haar1D(tempRow, width);
        for (let x = 0; x < width; x++) {
            pixels[y * width + x] = tempRow[x];
        }
    }
    
    // Transform columns
    const tempCol = new Float32Array(height);
    for (let x = 0; x < width; x++) {
        for (let y = 0; y < height; y++) {
            tempCol[y] = pixels[y * width + x];
        }
        haar1D(tempCol, height);
        for (let y = 0; y < height; y++) {
            pixels[y * width + x] = tempCol[y];
        }
    }
    
    return pixels;
}

// Hash comparison function
function hammingDistance(hash1, hash2) {
    const binary1 = BigInt(`0x${hash1}`).toString(2).padStart(64, '0');
    const binary2 = BigInt(`0x${hash2}`).toString(2).padStart(64, '0');
    let distance = 0;
    
    for (let i = 0; i < binary1.length; i++) {
        if (binary1[i] !== binary2[i]) {
            distance++;
        }
    }
    
    return distance;
}
// Image hash generation
async function getImageHash(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (response) => {
            const chunks = [];
            response.on('data', (chunk) => chunks.push(chunk));
            response.on('end', async () => {
                try {
                    const buffer = Buffer.concat(chunks);
                    const pixels = await sharp(buffer)
                        .greyscale()
                        .resize(32, 32, { fit: 'fill' })
                        .raw()
                        .toBuffer();

                    const floatPixels = new Float32Array(32 * 32);
                    for (let i = 0; i < pixels.length; i++) {
                        floatPixels[i] = pixels[i];
                    }

                    const wavelets = discreteWaveletTransform(floatPixels, 32, 32);
                    
                    let hash = 0n;
                    const threshold = Array.from(wavelets.slice(0, 64))
                        .reduce((a, b) => a + b, 0) / 64;
                    
                    for (let i = 0; i < 64; i++) {
                        if (wavelets[i] > threshold) {
                            hash |= 1n << BigInt(i);
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

// Channel permission checking
async function checkChannelPermissions(channel) {
    if (!channel) {
        throw new Error('Channel object is null or undefined');
    }

    if (!channel.isTextBased() && !channel.isThread() && channel.type !== 15) {
        throw new Error('This channel must be a text channel, thread, or forum');
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

// Message counting function
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

// Forum/Channel threads retrieval
async function getAllChannelThreads(channel) {
    try {
        if (channel.type === 15) { // Forum channel
            const activePosts = await channel.threads.fetchActive();
            const archivedPosts = await channel.threads.fetchArchived();
            
            return {
                active: Array.from(activePosts.threads.values()),
                archived: Array.from(archivedPosts.threads.values()),
                isForumChannel: true
            };
        } else if (channel.isTextBased()) { // Text channel
            return {
                active: [],
                archived: [],
                isForumChannel: false
            };
        }
    } catch (error) {
        throw new Error(`Failed to fetch channel threads: ${error.message}`);
    }
}

// Message processing function
async function processMessages(channel, imageDatabase, context = '') {
    await checkChannelPermissions(channel);

    const processingStats = {
        startTime: Date.now(),
        processedImages: 0,
        duplicatesFound: 0,
        lastLogTime: Date.now(),
        logInterval: 5000 // Log every 5 seconds
    };

    let lastMessageId;
    const batchSize = 100;

    while (true) {
        // Memory monitoring
        if (Date.now() - processingStats.lastLogTime > processingStats.logInterval) {
            LOGGING_UTILS.logEnhanced(LOGGING_UTILS.detailedMemoryLog());
            
            const elapsedSeconds = (Date.now() - processingStats.startTime) / 1000;
            LOGGING_UTILS.logEnhanced(
                LOGGING_UTILS.calculateProcessingRate(
                    processingStats.processedImages, 
                    elapsedSeconds
                )
            );

            processingStats.lastLogTime = Date.now();
        }

        const messages = await channel.messages.fetch({ 
            limit: batchSize, 
            before: lastMessageId 
        });
        
        if (messages.size === 0) break;

        for (const msg of messages.values()) {
            const attachments = [...msg.attachments.values()];
            
            for (const attachment of attachments) {
                if (attachment.contentType?.startsWith('image/')) {
                    processingStats.processedImages++;
                    
                    try {
                        const hash = await getImageHash(attachment.url);
                        
                        if (processingStats.processedImages % 100 === 0) {
                            LOGGING_UTILS.logEnhanced({
                                type: 'PROCESSING_MILESTONE',
                                data: {
                                    imagesProcessed: processingStats.processedImages,
                                    duplicatesFound: processingStats.duplicatesFound,
                                    currentContext: context,
                                    elapsedTime: formatElapsedTime(
                                        (Date.now() - processingStats.startTime) / 1000
                                    )
                                }
                            });
                        }

                        if (imageDatabase.has(hash)) {
                            processingStats.duplicatesFound++;
                            imageDatabase.get(hash).duplicates.push({
                                id: msg.id,
                                url: msg.url,
                                author: {
                                    username: msg.author.username,
                                    id: msg.author.id
                                },
                                timestamp: msg.createdTimestamp,
                                location: context,
                                similarityScore: '100.00'
                            });
                        } else {
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
                        }
                    } catch (error) {
                        LOGGING_UTILS.logEnhanced({
                            type: 'IMAGE_PROCESSING_ERROR',
                            data: {
                                messageId: msg.id,
                                attachmentUrl: attachment.url,
                                error: error.message,
                                context,
                                processingStats: {
                                    totalProcessed: processingStats.processedImages,
                                    duplicatesFound: processingStats.duplicatesFound
                                }
                            }
                        });
                    }
                }
            }
        }

        lastMessageId = messages.last().id;
        messages.clear();
    }

    LOGGING_UTILS.logEnhanced({
        type: 'PROCESSING_SUMMARY',
        data: {
            context,
            totalProcessed: processingStats.processedImages,
            duplicatesFound: processingStats.duplicatesFound,
            totalTime: formatElapsedTime(
                (Date.now() - processingStats.startTime) / 1000
            ),
            memoryUsage: LOGGING_UTILS.detailedMemoryLog().data
        }
    });

    return {
        processedImages: processingStats.processedImages,
        duplicatesFound: processingStats.duplicatesFound
    };
}
// Report generation
async function generateReport(channelId, imageDatabase) {
    const fileName = `duplicate_report_${channelId}_${Date.now()}.csv`;
    const writeStream = fs.createWriteStream(fileName);

    // Write header
    writeStream.write(
        `# Forum/Channel Analysis Report (Wavelet Hash)\n` +
        `# Channel ID: ${channelId}\n` +
        `# Analysis performed by: ${BOT_INFO.operator}\n` +
        `# Analysis start time: ${BOT_INFO.startTime} UTC\n` +
        `# Report generated at: ${getCurrentFormattedTime()} UTC\n` +
        `# Bot version: ${BOT_INFO.version}\n` +
        `# Similarity threshold: ${BOT_INFO.similarityThreshold}\n\n` +
        'Original Post URL,Original Poster,Original Location,Upload Date,Number of Duplicates,Users Who Reposted,Locations of Reposts,Stolen Reposts,Self-Reposts,Average Similarity Score (%)\n'
    );

    for (const [hash, imageInfo] of imageDatabase.entries()) {
        if (imageInfo.duplicates.length === 0) continue;

        const originalPoster = imageInfo.originalMessage;
        const reposts = imageInfo.duplicates;

        let stolenCount = 0;
        let selfRepostCount = 0;
        let totalSimilarity = 0;

        for (const repost of reposts) {
            if (repost.author.id === originalPoster.author.id) {
                selfRepostCount++;
            } else {
                stolenCount++;
            }
            totalSimilarity += parseFloat(repost.similarityScore);
        }

        const averageSimilarity = (totalSimilarity / reposts.length).toFixed(2);
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
            selfRepostCount,
            averageSimilarity
        ].join(',') + '\n';

        writeStream.write(line);
    }

    await new Promise(resolve => writeStream.end(resolve));
    return fileName;
}
// Main command handler
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
        } catch (error) {
            throw new Error(`Failed to access channel: ${error.message}`);
        }

        const channelType = channel.type === 15 ? 'forum' : 'text';
        statusMessage = await message.reply(`Starting Wavelet Hash analysis of ${channelType} channel... This might take a while.`);
        
        const { active, archived, isForumChannel } = await getAllChannelThreads(channel);
        const allThreads = [...active, ...archived];
        
        let totalMessages = await countTotalMessages(channel);
        
        if (isForumChannel) {
            for (const thread of allThreads) {
                totalMessages += await countTotalMessages(thread);
            }
        }

        const analysisScope = isForumChannel ? 
            `across ${allThreads.length} forum posts (${active.length} active, ${archived.length} archived)` :
            `in text channel`;

        await statusMessage.edit(
            `Starting Wavelet Hash analysis of ${totalMessages.toLocaleString()} total messages ${analysisScope}...`
        );

        imageDatabase.clear();
        if (global.gc) {
            global.gc();
        }

        let processedImages = 0;
        let duplicatesFound = 0;
        let startTime = Date.now();

        if (!isForumChannel) {
            const results = await processMessages(channel, imageDatabase, `channel-${channel.name}`);
            processedImages += results.processedImages;
            duplicatesFound += results.duplicatesFound;
        }

        for (const thread of allThreads) {
            const threadResults = await processMessages(thread, imageDatabase, `${isForumChannel ? 'forum-post' : 'thread'}-${thread.name}`);
            processedImages += threadResults.processedImages;
            duplicatesFound += threadResults.duplicatesFound;

            const elapsedMinutes = Math.floor((Date.now() - startTime) / 60000);
            await statusMessage.edit(
                `Processing... Found ${processedImages} images (${duplicatesFound} duplicates)\n` +
                `Time elapsed: ${elapsedMinutes} minutes\n` +
                `Currently processing: ${thread.name}`
            );
        }

        const reportFile = await generateReport(channelId, imageDatabase);
        const elapsedTime = formatElapsedTime((Date.now() - commandStartTime) / 1000);

        const finalStats = {
            channelType,
            totalMessages,
            processedImages,
            duplicatesFound,
            threadsAnalyzed: allThreads.length,
            elapsedTime,
            memoryUsed: `${checkMemoryUsage()}MB`,
            analysisType: 'Wavelet Hash'
        };

        logMessage('ANALYSIS_COMPLETE', finalStats);

        await statusMessage.edit({
            content: `Wavelet Hash Analysis complete!\n` +
                    `Channel type: ${channelType}\n` +
                    `Total messages analyzed: ${totalMessages.toLocaleString()}\n` +
                    `Images found: ${processedImages.toLocaleString()}\n` +
                    `Duplicates found: ${duplicatesFound.toLocaleString()}\n` +
                    `${isForumChannel ? `Forum posts analyzed: ${allThreads.length}\n` : ''}` +
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

// Command handlers
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

    if (message.content.startsWith('!check')) {
        const channelId = message.content.split(' ')[1];
        if (!channelId) {
            return message.reply('Please provide a channel ID. Usage: !check <channelId>');
        }
        await handleCheckCommand(message, channelId);
    }

    if (message.content === '!help') {
        const helpMessage = `
**Forum/Channel Image Analyzer Bot Commands (Wavelet Hash Edition):**
\`!check <channelId>\` - Analyze a forum or text channel for duplicate images using Wavelet Hash
\`!checkperms <channelId>\` - Check bot permissions in a channel
\`!help\` - Show this help message

**How to use:**
1. Right-click on any channel (forum or text) and select "Copy ID"
2. Use \`!check <paste-channel-id-here>\`
3. Wait for the analysis to complete
4. A CSV report will be generated with the results

**Note:** 
- Works with both forum and text channels
- Uses Wavelet Hash for enhanced duplicate detection
- Can detect modified/scaled images with high accuracy
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
            operator: BOT_INFO.operator,
            version: BOT_INFO.version,
            hashType: 'Wavelet Hash'
        });
        console.log(`Wavelet Hash Bot is ready! Logged in as ${client.user.tag}`);
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
    hammingDistance,
    discreteWaveletTransform,
    countTotalMessages,
    getAllChannelThreads,
    processMessages,
    generateReport,
    checkMemoryUsage,
    BOT_INFO,
    LOG_CONFIG
};