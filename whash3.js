const { Client, Events, GatewayIntentBits, PermissionsBitField } = require('discord.js');
const fsPromises = require('fs').promises;
const fs = require('fs');
const sharp = require('sharp');
const https = require('https');
const path = require('path');
const stream = require('stream').promises;
require('dotenv').config();

// Bot information
const BOT_INFO = {
    startTime: '2025-02-06 11:58:41',
    operator: 'noname9006',
    memoryLimit: 800,
    // Lower similarity threshold means a tighter match.
    similarityThreshold: 2,
    // New pixel difference threshold - the average absolute difference of pixels must be below this value.
    pixelSimilarityThreshold: 15,
    version: '1.1.0',
    outputDir: `duplicates_${new Date().toISOString().replace(/[:.]/g, '-')}`
};

// Enhanced logging utilities
const LOGGING_UTILS = {
    logDir: 'logs',
    startTime: '2025-02-06 11:58:41',
    operator: 'noname9006',

    detailedMemoryLog() {
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

    calculateETA(current, total, startTime = Date.now()) {
        const elapsedMs = Date.now() - startTime;
        const estimatedTotalMs = (elapsedMs / current) * total;
        const remainingMs = estimatedTotalMs - elapsedMs;
        const remainingMinutes = Math.ceil(remainingMs / 60000);
        return `~${remainingMinutes} minute${remainingMinutes !== 1 ? 's' : ''} remaining`;
    },

    calculateProgress(current, total) {
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

    calculateProcessingRate(processedItems, elapsedSeconds) {
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

    logEnhanced(data) {
        const logEntry = {
            timestamp: new Date().toISOString(),
            operator: this.operator,
            ...data
        };

        const logMessage = `[${logEntry.timestamp}] ${logEntry.type}: ${JSON.stringify(logEntry.data)}\n`;
        console.log(logMessage.trim());
        fsPromises.appendFile(path.join(this.logDir, `bot_log_${this.startTime.split(' ')[0]}.log`), logMessage)
            .catch(error => console.error('Logging error:', error));
    }
};

// Logging configuration
const LOG_CONFIG = {
    logDir: 'logs',
    logFile: `bot_log_${BOT_INFO.startTime.split(' ')[0]}.log`
};

// Create logs directory synchronously
try {
    if (!fs.existsSync(LOG_CONFIG.logDir)) {
        fs.mkdirSync(LOG_CONFIG.logDir, { recursive: true });
    }
} catch (error) {
    console.error('Error creating log directory:', error);
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

// Initialize image database and required data structures
// Each entry now stores the wavelet hash and the raw pixel data.
const imageDatabase = [];
const processingQueue = new Map();
const statisticsCache = new Map();
const activeProcesses = new Set();

// Database operation timestamps
const databaseMetadata = {
    lastCleanup: Date.now(),
    created: '2025-02-06 11:56:54',
    owner: 'noname9006',
    cleanupInterval: 1000 * 60 * 60, // 1 hour
    maxCacheAge: 1000 * 60 * 60 * 24   // 24 hours
};

// Initialize database cleanup interval
setInterval(() => {
    if (Date.now() - databaseMetadata.lastCleanup > databaseMetadata.cleanupInterval) {
        cleanupDatabase();
    }
}, databaseMetadata.cleanupInterval);

// Helper function to compute the median of an array
function median(values) {
    if (values.length === 0) return 0;
    const sorted = Array.from(values).sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2) {
        return sorted[mid];
    } else {
        return (sorted[mid - 1] + sorted[mid]) / 2;
    }
}

// Compare two 32x32 pixel arrays (Uint8Array or Buffer)
// Returns the average absolute difference over all pixels.
function comparePixelData(data1, data2) {
    if (data1.length !== data2.length) return Infinity;
    let totalDifference = 0;
    for (let i = 0; i < data1.length; i++) {
        totalDifference += Math.abs(data1[i] - data2[i]);
    }
    return totalDifference / data1.length;
}

// Command handling function
async function handleCheckCommand(message, channelId) {
    const commandStartTime = Date.now();
    let statusMessage = null;
    
    try {
        checkMemoryUsage();
        
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

        // Initial status message
        statusMessage = await message.reply(
            'Starting Wavelet Hash analysis... This might take a while.'
        );

        // Create output directory for this analysis using fsPromises.mkdir
        const analysisDir = BOT_INFO.outputDir;
        await fsPromises.mkdir(analysisDir, { recursive: true });

        LOGGING_UTILS.logEnhanced({
            type: 'ANALYSIS_START',
            data: {
                channelId,
                channelName: channel.name,
                startTime: getCurrentFormattedTime(),
                outputDir: analysisDir
            }
        });

        // Process messages and images
        const results = await processMessages(
            channel,
            imageDatabase,
            `channel-${channel.name}`,
            statusMessage
        );

        // Generate report
        const reportFile = await generateReport(channelId, imageDatabase);
        const elapsedTime = formatElapsedTime((Date.now() - commandStartTime) / 1000);

        // Final status update
        await statusMessage.edit({
            content: 
                `Wavelet Hash Analysis complete!\n` +
                `Channel: ${channel.name}\n` +
                `Images analyzed: ${results.processedImages.toLocaleString()}\n` +
                `Duplicates found: ${results.duplicatesFound.toLocaleString()}\n` +
                `Groups created: ${results.groupsCreated.toLocaleString()}\n` +
                `Time taken: ${elapsedTime}\n` +
                `Output directory: ${analysisDir}\n` +
                `Report file: ${reportFile}`,
            files: [path.join(analysisDir, reportFile)]
        });

        LOGGING_UTILS.logEnhanced({
            type: 'ANALYSIS_COMPLETE',
            data: {
                channelId,
                channelName: channel.name,
                results,
                elapsedTime,
                outputDir: analysisDir,
                reportFile,
                memoryUsage: LOGGING_UTILS.detailedMemoryLog().data
            }
        });

    } catch (error) {
        LOGGING_UTILS.logEnhanced({
            type: 'COMMAND_ERROR',
            data: {
                error: error.message,
                stack: error.stack,
                channelId
            }
        });

        const errorMessage = `Error during analysis: ${error.message}`;
        if (statusMessage) {
            await statusMessage.edit(errorMessage);
        } else {
            await message.reply(errorMessage);
        }
    }
}

function cleanupDatabase() {
    const now = Date.now();
    statisticsCache.forEach((value, key) => {
        if (now - value.timestamp > databaseMetadata.maxCacheAge) {
            statisticsCache.delete(key);
        }
    });
    databaseMetadata.lastCleanup = now;
    
    LOGGING_UTILS.logEnhanced({
        type: 'DATABASE_CLEANUP',
        data: {
            timestamp: getCurrentFormattedTime(),
            cacheSize: statisticsCache.size,
            databaseSize: imageDatabase.length,
            memoryUsage: LOGGING_UTILS.detailedMemoryLog().data
        }
    });
}

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

async function downloadImage(url, folderPath, filename) {
    try {
        await fsPromises.mkdir(folderPath, { recursive: true });
        const filepath = path.join(folderPath, filename);
        
        return new Promise((resolve, reject) => {
            https.get(url, (response) => {
                if (response.statusCode !== 200) {
                    reject(new Error(`Failed to download image: ${response.statusCode}`));
                    return;
                }

                const fileStream = fs.createWriteStream(filepath);
                response.pipe(fileStream);

                fileStream.on('finish', () => {
                    fileStream.close();
                    resolve(filepath);
                });

                fileStream.on('error', (err) => {
                    fs.unlink(filepath, () => {});
                    reject(err);
                });
            }).on('error', reject);
        });
    } catch (error) {
        LOGGING_UTILS.logEnhanced({
            type: 'IMAGE_DOWNLOAD_ERROR',
            data: {
                url,
                error: error.message,
                folderPath,
                filename,
                timestamp: getCurrentFormattedTime()
            }
        });
        throw error;
    }
}

function checkMemoryUsage() {
    const used = process.memoryUsage();
    const memoryUsageMB = Math.round(used.heapUsed / 1024 / 1024);
    
    if (memoryUsageMB > (BOT_INFO.memoryLimit * 0.8)) {
        LOGGING_UTILS.logEnhanced({
            type: 'MEMORY_WARNING',
            data: {
                currentUsageMB: memoryUsageMB,
                limitMB: BOT_INFO.memoryLimit
            }
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
        temp[i / 2] = avg;
        temp[size / 2 + i / 2] = diff;
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

// Hash comparison function using Hamming distance
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

// getImageHash now returns an object with both the hash and the 32x32 greyscale pixel data.
async function getImageHash(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (response) => {
            const chunks = [];
            response.on('data', (chunk) => chunks.push(chunk));
            response.on('end', async () => {
                try {
                    const buffer = Buffer.concat(chunks);
                    // Obtain a 32x32 greyscale image buffer
                    const pixelBuffer = await sharp(buffer)
                        .greyscale()
                        .resize(32, 32, { fit: 'fill' })
                        .raw()
                        .toBuffer();
                        
                    // Create a Float32Array for performing the wavelet transform
                    const floatPixels = new Float32Array(pixelBuffer.length);
                    for (let i = 0; i < pixelBuffer.length; i++) {
                        floatPixels[i] = pixelBuffer[i];
                    }

                    const wavelets = discreteWaveletTransform(floatPixels, 32, 32);

                    // Use the first 64 coefficients to compute a hash, using the median as threshold.
                    const coeffs = Array.from(wavelets.slice(0, 64));
                    const threshold = median(coeffs);
                    
                    let hash = 0n;
                    for (let i = 0; i < 64; i++) {
                        if (wavelets[i] > threshold) {
                            hash |= 1n << BigInt(i);
                        }
                    }
                    
                    resolve({
                        hash: hash.toString(16).padStart(16, '0'),
                        pixelData: pixelBuffer
                    });
                } catch (error) {
                    reject(error);
                }
            });
            response.on('error', (error) => reject(error));
        }).on('error', (error) => reject(error));
    });
}

// Channel and message processing functions using Hamming distance and pixel-level check.
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

    // Create base output directory using fsPromises.mkdir
    const baseOutputDir = BOT_INFO.outputDir;
    await fsPromises.mkdir(baseOutputDir, { recursive: true });

    LOGGING_UTILS.logEnhanced({
        type: 'PROCESSING_START',
        data: {
            context,
            channelName: channel.name,
            channelId: channel.id,
            startTime: new Date().toISOString(),
            outputDir: baseOutputDir
        }
    });

    let lastMessageId;
    const batchSize = 100;

    while (true) {
        if (Date.now() - processingStats.lastUpdateTime > processingStats.updateInterval) {
            const elapsedMinutes = Math.floor((Date.now() - processingStats.startTime) / 60000);
            const elapsedSeconds = (Date.now() - processingStats.startTime) / 1000;
            
            LOGGING_UTILS.logEnhanced({
                type: 'PROCESSING_PROGRESS',
                data: {
                    context,
                    channelName: channel.name,
                    processedImages: processingStats.processedImages,
                    duplicatesFound: processingStats.duplicatesFound,
                    elapsedTime: formatElapsedTime(elapsedSeconds),
                    currentGroup: processingStats.currentGroup,
                    outputDir: baseOutputDir,
                    memoryUsage: LOGGING_UTILS.detailedMemoryLog().data
                }
            });

            if (statusMessage) {
                const progressMessage = 
                    `Processing ${context}...\n` +
                    `Images found: ${processingStats.processedImages}\n` +
                    `Duplicates found: ${processingStats.duplicatesFound}\n` +
                    `Groups created: ${processingStats.currentGroup - 1}\n` +
                    `Time elapsed: ${elapsedMinutes} minutes\n` +
                    `Output directory: ${baseOutputDir}`;

                await statusMessage.edit(progressMessage).catch(error => {
                    LOGGING_UTILS.logEnhanced({
                        type: 'MESSAGE_UPDATE_ERROR',
                        data: { error: error.message, context }
                    });
                });
            }
            
            processingStats.lastUpdateTime = Date.now();
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
                        // Get hash and pixel data for the new image.
                        const { hash: newHash, pixelData: newPixelData } = await getImageHash(attachment.url);
                        let duplicateFound = false;
                        for (const entry of imageDatabase) {
                            const distance = hammingDistance(entry.hash, newHash);
                            if (distance <= BOT_INFO.similarityThreshold) {
                                // Additional pixel-level check
                                const avgPixelDiff = comparePixelData(entry.pixelData, newPixelData);
                                if (avgPixelDiff <= BOT_INFO.pixelSimilarityThreshold) {
                                    duplicateFound = true;
                                    processingStats.duplicatesFound++;
                                    const groupFolder = path.join(
                                        baseOutputDir, 
                                        String(entry.data.groupId).padStart(6, '0')
                                    );

                                    if (entry.data.duplicates.length === 0) {
                                        try {
                                            const originalExt = path.extname(entry.data.originalMessage.attachment.name);
                                            await downloadImage(
                                                entry.data.originalMessage.attachment.url,
                                                groupFolder,
                                                `#0riginal${originalExt}`
                                            );
                                        } catch (error) {
                                            LOGGING_UTILS.logEnhanced({
                                                type: 'ORIGINAL_SAVE_ERROR',
                                                data: {
                                                    error: error.message,
                                                    url: entry.data.originalMessage.attachment.url,
                                                    groupId: entry.data.groupId
                                                }
                                            });
                                        }
                                    }

                                    try {
                                        await downloadImage(
                                            attachment.url,
                                            groupFolder,
                                            attachment.name
                                        );
                                    } catch (error) {
                                        LOGGING_UTILS.logEnhanced({
                                            type: 'DUPLICATE_SAVE_ERROR',
                                            data: {
                                                error: error.message,
                                                url: attachment.url,
                                                groupId: entry.data.groupId
                                            }
                                        });
                                    }

                                    entry.data.duplicates.push({
                                        id: msg.id,
                                        url: msg.url,
                                        author: {
                                            username: msg.author.username,
                                            id: msg.author.id
                                        },
                                        timestamp: msg.createdTimestamp,
                                        location: context,
                                        similarityScore: distance.toFixed(2),
                                        pixelDifference: avgPixelDiff.toFixed(2),
                                        attachment: {
                                            url: attachment.url,
                                            name: attachment.name,
                                            savedPath: path.join(groupFolder, attachment.name)
                                        }
                                    });
                                    break;
                                }
                            }
                        }

                        // If no similar image was found, add as a new image entry
                        if (!duplicateFound) {
                            imageDatabase.push({
                                hash: newHash,
                                // Store the raw pixel data along with the entry
                                pixelData: newPixelData,
                                data: {
                                    groupId: processingStats.currentGroup++,
                                    originalMessage: {
                                        id: msg.id,
                                        url: msg.url,
                                        author: {
                                            username: msg.author.username,
                                            id: msg.author.id
                                        },
                                        timestamp: msg.createdTimestamp,
                                        location: context,
                                        attachment: {
                                            url: attachment.url,
                                            name: attachment.name
                                        }
                                    },
                                    duplicates: []
                                }
                            });
                        }
                    } catch (error) {
                        LOGGING_UTILS.logEnhanced({
                            type: 'IMAGE_PROCESSING_ERROR',
                            data: {
                                messageId: msg.id,
                                attachmentUrl: attachment.url,
                                error: error.message,
                                context
                            }
                        });
                    }
                }
            }
        }

        lastMessageId = messages.last().id;
        messages.clear();
    }

    return {
        processedImages: processingStats.processedImages,
        duplicatesFound: processingStats.duplicatesFound,
        groupsCreated: processingStats.currentGroup - 1
    };
}

// Report generation
async function generateReport(channelId, imageDatabase) {
    const timestamp = getCurrentFormattedTime();
    const fileName = `duplicate_report_${channelId}_${Date.now()}.csv`;
    const writeStream = fs.createWriteStream(path.join(BOT_INFO.outputDir, fileName));

    writeStream.write(
        `# Forum/Channel Analysis Report (Wavelet Hash with Pixel Verification)\n` +
        `# Channel ID: ${channelId}\n` +
        `# Analysis performed by: ${BOT_INFO.operator}\n` +
        `# Analysis start time: ${BOT_INFO.startTime} UTC\n` +
        `# Report generated at: ${timestamp} UTC\n` +
        `# Bot version: ${BOT_INFO.version}\n` +
        `# Similarity threshold: ${BOT_INFO.similarityThreshold}\n` +
        `# Pixel similarity threshold: ${BOT_INFO.pixelSimilarityThreshold}\n` +
        `# Output directory: ${BOT_INFO.outputDir}\n\n` +
        'Group ID,Original Post URL,Original Poster,Original Location,Upload Date,' +
        'Number of Duplicates,Users Who Reposted,Locations of Reposts,Stolen Reposts,' +
        'Self-Reposts,Average Similarity Score,Average Pixel Difference,Local Folder Path,Original Filename,' +
        'Duplicate Filenames\n'
    );

    for (const entry of imageDatabase) {
        if (entry.data.duplicates.length === 0) continue;

        const originalPoster = entry.data.originalMessage;
        const reposts = entry.data.duplicates;
        const groupFolder = path.join(BOT_INFO.outputDir, String(entry.data.groupId).padStart(6, '0'));

        let stolenCount = 0;
        let selfRepostCount = 0;
        let totalSimilarity = 0;
        let totalPixelDiff = 0;

        for (const repost of reposts) {
            if (repost.author.id === originalPoster.author.id) {
                selfRepostCount++;
            } else {
                stolenCount++;
            }
            totalSimilarity += parseFloat(repost.similarityScore);
            totalPixelDiff += parseFloat(repost.pixelDifference);
        }

        const averageSimilarity = (totalSimilarity / reposts.length).toFixed(2);
        const averagePixelDiff = (totalPixelDiff / reposts.length).toFixed(2);
        const uploadDate = new Date(originalPoster.timestamp).toISOString().split('T')[0];
        
        const line = [
            String(entry.data.groupId).padStart(6, '0'),
            originalPoster.url,
            originalPoster.author.username,
            originalPoster.location,
            uploadDate,
            reposts.length,
            reposts.map(d => d.author.username).join(';'),
            reposts.map(d => d.location).join(';'),
            stolenCount,
            selfRepostCount,
            averageSimilarity,
            averagePixelDiff,
            groupFolder,
            `#0riginal${path.extname(originalPoster.attachment.name)}`,
            reposts.map(d => d.attachment.name).join(';')
        ].join(',') + '\n';

        writeStream.write(line);
    }

    await new Promise(resolve => writeStream.end(resolve));
    return fileName;
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
**Forum/Channel Image Analyzer Bot Commands (Wavelet Hash + Pixel Verification Edition):**
\`!check <channelId>\` - Analyze a forum or text channel for duplicate images using Wavelet Hash combined with pixel-level verification
\`!checkperms <channelId>\` - Check bot permissions in a channel
\`!help\` - Show this help message

**How to use:**
1. Right-click on any channel (forum or text) and select "Copy ID"
2. Use \`!check <paste-channel-id-here>\`
3. Wait for the analysis to complete
4. A CSV report will be generated with the results

**Note:** 
- Uses Wavelet Hash to generate a compact fingerprint.
- Applies a hamming distance check with a strict similarity threshold.
- Further validates potential duplicates by comparing the 32x32 greyscale pixel data.
- Adjust BOT_INFO.similarityThreshold and BOT_INFO.pixelSimilarityThreshold to reduce false positives.
`;
        message.reply(helpMessage);
    }
});

// Error handling
client.on(Events.Error, error => {
    LOGGING_UTILS.logEnhanced({
        type: 'DISCORD_ERROR',
        data: {
            error: error.message,
            stack: error.stack
        }
    });
});

process.on('unhandledRejection', error => {
    LOGGING_UTILS.logEnhanced({
        type: 'UNHANDLED_REJECTION',
        data: {
            error: error.message,
            stack: error.stack
        }
    });
});

process.on('uncaughtException', error => {
    LOGGING_UTILS.logEnhanced({
        type: 'UNCAUGHT_EXCEPTION',
        data: {
            error: error.message,
            stack: error.stack
        }
    });
    process.exit(1);
});

// Bot initialization
if (!process.env.DISCORD_BOT_TOKEN) {
    LOGGING_UTILS.logEnhanced({
        type: 'STARTUP_ERROR',
        data: 'No Discord bot token found in environment variables!'
    });
    process.exit(1);
}

client.login(process.env.DISCORD_BOT_TOKEN)
    .then(() => {
        LOGGING_UTILS.logEnhanced({
            type: 'BOT_LOGIN_SUCCESS',
            data: {
                username: client.user.tag,
                startTime: BOT_INFO.startTime,
                operator: BOT_INFO.operator,
                version: BOT_INFO.version,
                hashType: 'Wavelet Hash + Pixel Verification',
                outputDir: BOT_INFO.outputDir
            }
        });
        console.log(`Wavelet Hash Bot is ready! Logged in as ${client.user.tag}`);
    })
    .catch(error => {
        LOGGING_UTILS.logEnhanced({
            type: 'BOT_LOGIN_ERROR',
            data: {
                error: error.message,
                stack: error.stack
            }
        });
        process.exit(1);
});