const { Client, Events, GatewayIntentBits, PermissionsBitField, EmbedBuilder } = require('discord.js');
const fs = require('fs');
const { imageHash } = require('image-hash');
const https = require('https');
const path = require('path');
const { promisify } = require('util');
const { pipeline } = require('stream');
const os = require('os');
require('dotenv').config();

// Convert callback-based functions to Promise-based
const imageHashAsync = promisify(imageHash);
const pipelineAsync = promisify(pipeline);
const unlinkAsync = promisify(fs.unlink);

// Bot information
const BOT_INFO = {
    startTime: new Date().toISOString().replace('T', ' ').split('.')[0],
    memoryLimit: 8000 // MB
};

const DUPE_CONFIG = {
    saveDupes: process.env.SAVEDUPE === 'true',
    saveDir: 'duplicate_images',
    counterFile: 'dupe_counter.json'
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
    DUPLICATE_FOUND: 'DUPLICATE_FOUND',
    IMAGE_ERROR: 'IMAGE_PROCESSING_ERROR',
    VALIDATION_ERROR: 'IMAGE_VALIDATION_ERROR',
    BOT_STATUS: 'BOT_STATUS_UPDATE',
    DEBUG: 'DEBUG_INFO'
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

// In-memory hash tables for tracked channels
const channelHashTables = {};

// Retrieve tracked channels from environment variables
const TRACKED_CHANNELS = process.env.TRACKED_CHANNELS 
    ? process.env.TRACKED_CHANNELS.split(',').map(channelId => channelId.trim())
    : [];
// ----------------------
// Utility Functions
// ----------------------

function formatElapsedTime(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainingSeconds = Math.floor(seconds % 60);
    return hours > 0
        ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`
        : `${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`;
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

function createProgressBar(progress) {
    const barLength = 20;
    const filledLength = Math.round(progress * barLength);
    const emptyLength = barLength - filledLength;
    return '█'.repeat(filledLength) + '░'.repeat(emptyLength);
}

function ensureSaveDirectory() {
    if (!fs.existsSync(DUPE_CONFIG.saveDir)) {
        fs.mkdirSync(DUPE_CONFIG.saveDir, { recursive: true });
    }
}

function loadDupeCounter() {
    try {
        if (fs.existsSync(path.join(DUPE_CONFIG.saveDir, DUPE_CONFIG.counterFile))) {
            return JSON.parse(fs.readFileSync(path.join(DUPE_CONFIG.saveDir, DUPE_CONFIG.counterFile)));
        }
    } catch (error) {
        console.error('Error loading dupe counter:', error);
    }
    return { currentCounter: 1 };
}

function saveDupeCounter(counter) {
    try {
        fs.writeFileSync(
            path.join(DUPE_CONFIG.saveDir, DUPE_CONFIG.counterFile),
            JSON.stringify(counter)
        );
    } catch (error) {
        console.error('Error saving dupe counter:', error);
    }
}

async function downloadImage(url, destPath) {
    return new Promise((resolve, reject) => {
        const fileStream = fs.createWriteStream(destPath);
        https.get(url, (response) => {
            if (response.statusCode !== 200) {
                fileStream.close();
                reject(new Error(`Failed to fetch image: ${response.statusCode}`));
                return;
            }

            pipeline(response, fileStream, (err) => {
                if (err) {
                    console.error(`Error downloading image from ${url}:`, err);
                    reject(err);
                } else {
                    resolve(true);
                }
            });
        }).on('error', (err) => {
            fileStream.close();
            console.error(`Network error downloading image from ${url}:`, err);
            reject(err);
        });
    });
}

async function saveImageAndDupes(originalAttachment, duplicateAttachments) {
    if (!DUPE_CONFIG.saveDupes) return;
    
    ensureSaveDirectory();
    
    // Load or initialize the counter
    const counter = loadDupeCounter();
    const seriesNumber = counter.currentCounter.toString().padStart(4, '0');
    
    // Extract original filename and extension
    const originalUrl = new URL(originalAttachment.url);
    const originalFilename = path.basename(originalUrl.pathname);
    
    // Save original
    const originalDestPath = path.join(
        DUPE_CONFIG.saveDir,
        `${seriesNumber}_ORIGINAL_${originalFilename}`
    );
    
    try {
        // Only proceed if we successfully download the original
        await downloadImage(originalAttachment.url, originalDestPath);
        console.log(`Saved original image: ${originalDestPath}`);
        
        // Save all dupes
        for (let i = 0; i < duplicateAttachments.length; i++) {
            const dupeAttachment = duplicateAttachments[i];
            const dupeNumber = (i + 1).toString().padStart(2, '0');
            const dupeUrl = new URL(dupeAttachment.url);
            const dupeFilename = path.basename(dupeUrl.pathname);
            
            const dupeDestPath = path.join(
                DUPE_CONFIG.saveDir,
                `${seriesNumber}_DUPE_${dupeNumber}_${dupeFilename}`
            );
            
            try {
                await downloadImage(dupeAttachment.url, dupeDestPath);
                console.log(`Saved duplicate image: ${dupeDestPath}`);
            } catch (err) {
                console.error(`Failed to save duplicate image ${dupeNumber}:`, err);
            }
        }
        
        // Increment and save counter
        counter.currentCounter++;
        saveDupeCounter(counter);
    } catch (err) {
        console.error('Failed to save original image:', err);
    }
}

function isSupportedImage(attachment) {
    try {
        // Check if it's an image at all
        if (!attachment.contentType?.startsWith('image/')) {
            throw new Error('Not an image file');
        }

        // Check if it's a GIF (which we don't want to process)
        if (attachment.contentType === 'image/gif') {
            throw new Error('GIF images are not supported');
        }

        // Accept all other image types
        return true;
    } catch (error) {
        logMessage(LOG_EVENTS.VALIDATION_ERROR, {
            url: attachment.url,
            error: error.message
        });
        return false;
    }
}

// ----------------------
// Database Functions
// ----------------------

function loadHashDatabase(channelId) {
    const filePath = `hashtable_${channelId}.json`;
    if (fs.existsSync(filePath)) {
        try {
            console.log(`Loading hash database from ${filePath}`);
            const data = fs.readFileSync(filePath);
            const jsonData = JSON.parse(data);
            console.log(`Successfully loaded ${Object.keys(jsonData).length} entries from hash database`);
            return new Map(Object.entries(jsonData));
        } catch (err) {
            console.error('Error loading hash database:', err);
            logMessage('LOAD_ERROR', { error: err.message });
            return new Map();
        }
    }
    console.log(`No existing hash database found for channel ${channelId}`);
    return new Map();
}

function saveHashDatabase(channelId, hashDB) {
    const filePath = `hashtable_${channelId}.json`;
    try {
        console.log(`Saving hash database to ${filePath}`);
        const obj = Object.fromEntries(hashDB);
        fs.writeFileSync(filePath, JSON.stringify(obj, null, 2));
        console.log(`Successfully saved ${hashDB.size} entries to hash database`);
    } catch (err) {
        console.error('Error saving hash database:', err);
        logMessage('SAVE_ERROR', { error: err.message });
    }
}
// ----------------------
// Image Processing Functions
// ----------------------

async function getImageHash(url) {
    const tmpdir = os.tmpdir();
    const tmpfile = path.join(tmpdir, `temp_${Date.now()}_${Math.random().toString(36).substring(7)}`);
    
    try {
        console.log(`Downloading image from ${url}`);
        await new Promise((resolve, reject) => {
            const file = fs.createWriteStream(tmpfile);
            https.get(url, (response) => {
                if (response.statusCode !== 200) {
                    reject(new Error(`Failed to download image: ${response.statusCode}`));
                    return;
                }
                pipeline(response, file, (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            }).on('error', reject);
        });

        console.log('Calculating image hash...');
        const hash = await imageHashAsync(tmpfile, 16, true);
        console.log('Image hash calculated successfully');
        return hash;
    } catch (error) {
        console.error('Error processing image:', error);
        throw new Error(`Failed to process image: ${error.message}`);
    } finally {
        try {
            await unlinkAsync(tmpfile);
            console.log('Temporary file cleaned up');
        } catch (error) {
            console.error('Failed to clean up temporary file:', error);
        }
    }
}
// ----------------------
// Processing Functions
// ----------------------

async function processMessages(channel, imageDatabase, context = '') {
    console.log(`Processing messages in ${context || channel.id}`);
    await checkChannelPermissions(channel);
    let processedImages = 0;
    let duplicatesFound = 0;
    let lastMessageId;
    const batchSize = 100;
    let processedMessages = 0;

    while (true) {
        const currentMemory = checkMemoryUsage();
        if (currentMemory > (BOT_INFO.memoryLimit * 0.8) && global.gc) {
            console.log('Running garbage collection...');
            global.gc();
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        const options = { limit: batchSize };
        if (lastMessageId) options.before = lastMessageId;
        
        const messages = await channel.messages.fetch(options);
        if (messages.size === 0) break;

        processedMessages += messages.size;
        console.log(`Processing batch of ${messages.size} messages (total: ${processedMessages})`);

        for (const msg of messages.values()) {
            const attachments = [...msg.attachments.values()];
            for (const attachment of attachments) {
                if (!attachment.contentType?.startsWith('image/')) continue;
                if (!isSupportedImage(attachment)) continue;

                processedImages++;
                try {
                    const hash = await getImageHash(attachment.url);
                    if (!imageDatabase.has(hash)) {
                        console.log(`New unique image found in ${msg.url}`);
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
                        console.log(`Duplicate image found in ${msg.url}`);
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
                    console.error('Error processing image:', error);
                    logMessage(LOG_EVENTS.IMAGE_ERROR, {
                        messageId: msg.id,
                        attachmentUrl: attachment.url,
                        error: error.message
                    });
                }
            }
        }

        if (processedMessages % 1000 === 0) {
            console.log(`Progress update: ${processedMessages} messages processed, ${processedImages} images found, ${duplicatesFound} duplicates`);
        }

        lastMessageId = messages.last().id;
        messages.clear();
    }

    console.log(`Finished processing messages in ${context || channel.id}`);
    console.log(`Total: ${processedImages} images processed, ${duplicatesFound} duplicates found`);

    return { processedImages, duplicatesFound };
}
// ----------------------
// Report Generation Helper Functions
// ----------------------

function groupDuplicatesByAuthor(imageDatabase) {
    const authorStats = new Map();
    
    for (const [hash, imageInfo] of imageDatabase.entries()) {
        const originalAuthorId = imageInfo.originalMessage.author.id;
        const duplicates = imageInfo.duplicates;
        
        for (const duplicate of duplicates) {
            const repostAuthorId = duplicate.author.id;
            const isSelfRepost = originalAuthorId === repostAuthorId;
            
            if (!authorStats.has(repostAuthorId)) {
                authorStats.set(repostAuthorId, {
                    username: duplicate.author.username,
                    selfReposts: 0,
                    stolenReposts: 0,
                    victimOf: 0,
                    totalReposts: 0
                });
            }
            
            const stats = authorStats.get(repostAuthorId);
            if (isSelfRepost) {
                stats.selfReposts++;
            } else {
                stats.stolenReposts++;
                
                // Track original poster as victim
                if (!authorStats.has(originalAuthorId)) {
                    authorStats.set(originalAuthorId, {
                        username: imageInfo.originalMessage.author.username,
                        selfReposts: 0,
                        stolenReposts: 0,
                        victimOf: 0,
                        totalReposts: 0
                    });
                }
                authorStats.get(originalAuthorId).victimOf++;
            }
            stats.totalReposts++;
        }
    }
    
    return authorStats;
}

function generateAuthorReport(channelId, authorStats) {
    console.log(`Generating author report for channel ${channelId}`);
    const fileName = `author_report_${channelId}_${Date.now()}.csv`;
    
    const headers = [
        'Username',
        'Total Reposts',
        'Self Reposts',
        'Stolen Reposts',
        'Times Been Reposted',
        'Repost Ratio'
    ].join(',') + '\n';
    
    const lines = [];
    for (const [authorId, stats] of authorStats.entries()) {
        const repostRatio = stats.totalReposts > 0 
            ? (stats.stolenReposts / stats.totalReposts).toFixed(2) 
            : '0.00';
            
        lines.push([
            stats.username,
            stats.totalReposts,
            stats.selfReposts,
            stats.stolenReposts,
            stats.victimOf,
            repostRatio
        ].join(','));
    }
    
    fs.writeFileSync(fileName, headers + lines.join('\n'));
    console.log(`Author report generated successfully: ${fileName}`);
    return fileName;
}

async function generateReport(channelId, imageDatabase) {
    console.log(`Generating report for channel ${channelId}`);
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

    let processedEntries = 0;
    console.log(`Processing ${imageDatabase.size} entries for report`);

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
        
        processedEntries++;
        if (processedEntries % 100 === 0) {
            console.log(`Report progress: ${processedEntries}/${imageDatabase.size} entries processed`);
        }
    }

    await new Promise(resolve => writeStream.end(resolve));
    console.log(`Report generated successfully: ${fileName}`);
    return fileName;
}

// ----------------------
// Permission and Channel Functions
// ----------------------

async function checkChannelPermissions(channel) {
    console.log(`Checking permissions for channel ${channel.id}`);
    if (!channel) {
        console.error('Channel object is null or undefined');
        throw new Error('Channel object is null or undefined');
    }
    
    if (!channel.isTextBased() && !channel.isThread() && channel.type !== 15) {
        console.error(`Invalid channel type: ${channel.type}`);
        throw new Error('This channel is not a text channel, thread, or forum');
    }
    
    const permissions = channel.permissionsFor(client.user);
    if (!permissions) {
        console.error('Cannot check permissions for this channel');
        throw new Error('Cannot check permissions for this channel');
    }
    
    const requiredPermissions = ['ViewChannel', 'ReadMessageHistory', 'SendMessages'];
    const missingPermissions = requiredPermissions.filter(perm => !permissions.has(perm));
    
    if (missingPermissions.length > 0) {
        console.error(`Missing permissions: ${missingPermissions.join(', ')}`);
        throw new Error(`Missing required permissions: ${missingPermissions.join(', ')}`);
    }
    
    console.log('All required permissions are present');
    return true;
}

async function countTotalMessages(channel) {
    console.log(`Counting messages in channel ${channel.id}`);
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
            
            if (totalMessages % 1000 === 0) {
                console.log(`Counted ${totalMessages} messages so far...`);
            }
        }
        console.log(`Finished counting messages. Total: ${totalMessages}`);
        return totalMessages;
    } catch (error) {
        console.error('Error counting messages:', error);
        throw new Error(`Failed to count messages: ${error.message}`);
    }
}

async function getAllForumPosts(channel) {
    console.log(`Fetching forum posts for channel ${channel.id}`);
    if (channel.type !== 15) {
        console.error('Invalid channel type for forum posts');
        throw new Error('This is not a forum channel');
    }
    
    try {
        console.log('Fetching active posts...');
        const activePosts = await channel.threads.fetchActive();
        console.log(`Found ${activePosts.threads.size} active posts`);

        console.log('Fetching archived posts...');
        const archivedPosts = await channel.threads.fetchArchived();
        console.log(`Found ${archivedPosts.threads.size} archived posts`);

        return {
            active: Array.from(activePosts.threads.values()),
            archived: Array.from(archivedPosts.threads.values())
        };
    } catch (error) {
        console.error('Error fetching forum posts:', error);
        throw new Error(`Failed to fetch forum posts: ${error.message}`);
    }
}
// ----------------------
// Message Processing Functions
// ----------------------

async function buildHashDatabaseForChannel(channel, commandChannel) {
    let hashDB = new Map();
    let lastMessageId;
    const batchSize = 100;
    let processedMessages = 0;
    let processedImages = 0;
    let startTime = Date.now();
    let statusMessage = null;

    try {
        // First, count total messages for progress calculation
        const totalMessages = await countTotalMessages(channel);
        console.log(`Starting hash database build for channel ${channel.id}. Total messages: ${totalMessages}`);

        try {
            // Send status message to the command channel
            statusMessage = await commandChannel.send(`Starting hash database build...\nTotal messages to process: ${totalMessages.toLocaleString()}`);
            console.log('Initial status message sent successfully to command channel');
        } catch (error) {
            console.error('Failed to send initial status message:', error);
            throw new Error(`Cannot send messages to command channel: ${error.message}`);
        }

        while (true) {
            const options = { limit: batchSize };
            if (lastMessageId) options.before = lastMessageId;
            
            const messages = await channel.messages.fetch(options);
            if (messages.size === 0) break;

            for (const msg of messages.values()) {
                processedMessages++;
                const attachments = [...msg.attachments.values()];
                
                for (const attachment of attachments) {
                    if (!attachment.contentType?.startsWith('image/')) continue;
                    if (!isSupportedImage(attachment)) continue;

                    processedImages++;
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
                        }
                    } catch (err) {
                        console.error('Error processing image:', err);
                        logMessage(LOG_EVENTS.IMAGE_ERROR, {
                            messageId: msg.id,
                            attachmentUrl: attachment.url,
                            error: err.message
                        });
                    }
                }

                // Update progress every 100 messages or when reaching the end
                if (processedMessages % 100 === 0 || processedMessages === totalMessages) {
                    const progress = ((processedMessages / totalMessages) * 100).toFixed(2);
                    const elapsedTime = Math.floor((Date.now() - startTime) / 1000);
                    const timeString = formatElapsedTime(elapsedTime);
                    
                    const progressBar = createProgressBar(processedMessages / totalMessages);
                    const statusText = 
                        `Building hash database...\n` +
                        `${progressBar}\n` +
                        `Progress: ${progress}% (${processedMessages.toLocaleString()}/${totalMessages.toLocaleString()} messages)\n` +
                        `Images processed: ${processedImages.toLocaleString()}\n` +
                        `Unique images: ${hashDB.size.toLocaleString()}\n` +
                        `Time elapsed: ${timeString}`;

                    console.log(statusText);

                    try {
                        await statusMessage.edit(statusText);
                        console.log(`Progress update sent successfully at ${progress}%`);
                    } catch (error) {
                        console.error('Failed to update status message:', error);
                        // Try to send a new message if edit fails
                        try {
                            statusMessage = await commandChannel.send(statusText);
                        } catch (sendError) {
                            console.error('Failed to send new status message:', sendError);
                        }
                    }
                }
            }
            
            lastMessageId = messages.last().id;
            messages.clear();
            if (global.gc) global.gc();
        }

        const totalTime = formatElapsedTime(Math.floor((Date.now() - startTime) / 1000));
        const finalStatus = 
            `Hash database build complete!\n` +
            `Total messages processed: ${processedMessages.toLocaleString()}\n` +
            `Total images processed: ${processedImages.toLocaleString()}\n` +
            `Unique images: ${hashDB.size.toLocaleString()}\n` +
            `Time taken: ${totalTime}`;

        console.log(finalStatus);

        try {
            await statusMessage.edit(finalStatus);
            console.log('Final status update sent successfully');
        } catch (error) {
            console.error('Failed to send final status:', error);
            // Try to send a new message if edit fails
            await commandChannel.send(finalStatus).catch(console.error);
        }

        return hashDB;
    } catch (error) {
        console.error('Error in buildHashDatabaseForChannel:', error);
        const errorMessage = `Error building hash database: ${error.message}`;
        try {
            if (statusMessage) {
                await statusMessage.edit(errorMessage);
            } else {
                await commandChannel.send(errorMessage);
            }
        } catch (messageError) {
            console.error('Failed to send error message:', messageError);
        }
        throw error;
    }
}
// ----------------------
// Command Handlers
// ----------------------

async function handleCheckCommand(message, channelId) {
    console.log(`Check command initiated for channel ${channelId} from message channel ${message.channel.id}`);
    const commandStartTime = Date.now();
    let statusMessage = null;
    
    try {
        if (!channelId.match(/^\d+$/)) {
            console.error('Invalid channel ID format');
            return message.channel.send('Invalid channel ID format');
        }

        let channel;
        try {
            console.log('Fetching channel...');
            channel = await client.channels.fetch(channelId);
            if (!channel) throw new Error('Channel not found');
            if (channel.type !== 15) throw new Error('This channel is not a forum channel');
            console.log('Channel fetched successfully');
        } catch (error) {
            console.error('Failed to access channel:', error);
            return message.channel.send(`Failed to access channel: ${error.message}`);
        }

        statusMessage = await message.channel.send('Starting forum analysis... This might take a while.');
        console.log('Initial status message sent');
        
        console.log('Fetching forum posts...');
        const { active: activePosts, archived: archivedPosts } = await getAllForumPosts(channel);
        const allPosts = [...activePosts, ...archivedPosts];
        console.log(`Found ${allPosts.length} total posts (${activePosts.length} active, ${archivedPosts.length} archived)`);
        
        let totalMessages = 0;
        console.log('Counting messages in all posts...');
        for (const post of allPosts) {
            totalMessages += await countTotalMessages(post);
        }
        console.log(`Total messages to process: ${totalMessages}`);

        await statusMessage.edit(
            `Starting analysis of ${totalMessages.toLocaleString()} total messages across ${allPosts.length} forum posts...`
        );

        const imageDatabase = new Map();
        if (global.gc) {
            console.log('Running garbage collection before main processing');
            global.gc();
        }

        let processedImages = 0;
        let duplicatesFound = 0;
        let startTime = Date.now();

        console.log('Starting main post processing...');
        for (const post of allPosts) {
            console.log(`Processing post: ${post.name}`);
            const postResults = await processMessages(post, imageDatabase, `forum-post-${post.name}`);
            processedImages += postResults.processedImages;
            duplicatesFound += postResults.duplicatesFound;
            
            const elapsedMinutes = Math.floor((Date.now() - startTime) / 60000);
            const progressBar = createProgressBar((allPosts.indexOf(post) + 1) / allPosts.length);
            
            const statusUpdate = 
                `Processing forum posts...\n` +
                `${progressBar}\n` +
                `Found ${processedImages.toLocaleString()} images (${duplicatesFound.toLocaleString()} duplicates)\n` +
                `Time elapsed: ${elapsedMinutes} minutes\n` +
                `Currently processing: ${post.name}`;

            console.log(statusUpdate);
            
            try {
                await statusMessage.edit(statusUpdate);
            } catch (error) {
                console.error('Failed to update status message:', error);
                try {
                    statusMessage = await message.channel.send(statusUpdate);
                } catch (sendError) {
                    console.error('Failed to send new status message:', sendError);
                }
            }
        }

        console.log('Generating final report...');
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

        console.log('Analysis complete:', finalStats);
        logMessage('ANALYSIS_COMPLETE', finalStats);
        
        const finalMessage = {
            content: `Analysis complete!\n` +
                    `Total messages analyzed: ${totalMessages.toLocaleString()}\n` +
                    `Images found: ${processedImages.toLocaleString()}\n` +
                    `Duplicates found: ${duplicatesFound.toLocaleString()}\n` +
                    `Forum posts analyzed: ${allPosts.length}\n` +
                    `Time taken: ${elapsedTime}\n` +
                    `Report saved as: ${reportFile}`,
            files: [reportFile]
        };

        try {
            await statusMessage.edit(finalMessage);
            console.log('Final status message sent successfully');
        } catch (error) {
            console.error('Failed to send final status message:', error);
            await message.channel.send(finalMessage).catch(err => 
                console.error('Failed to send alternative final message:', err)
            );
        }
    } catch (error) {
        console.error('Error in handleCheckCommand:', error);
        const errorMessage = `An error occurred: ${error.message}`;
        try {
            if (statusMessage) {
                await statusMessage.edit(errorMessage);
            } else {
                await message.channel.send(errorMessage);
            }
        } catch (messageError) {
            console.error('Failed to send error message:', messageError);
        }
    }
}
// ----------------------
// Event Handlers
// ----------------------

client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;

    // Handle commands
    if (message.content.startsWith('!')) {
        console.log(`Command received in channel ${message.channel.id}: ${message.content}`);
        const [command, ...args] = message.content.split(' ');

        switch(command) {
            case '!hash':
                console.log('Hash command processing started');
                logMessage(LOG_EVENTS.HASH_COMMAND, { 
                    content: message.content,
                    commandChannelId: message.channel.id 
                });
                const channelId = args[0];
                
                if (!channelId) {
                    console.log('Hash command failed: No channel ID provided');
                    return message.channel.send('Please provide a channel ID. Usage: !hash <channel_id>')
                        .catch(err => console.error('Failed to send response:', err));
                }

                try {
                    console.log(`Fetching channel ${channelId}`);
                    const targetChannel = await client.channels.fetch(channelId);
                    if (!targetChannel) {
                        console.log('Hash command failed: Channel not found');
                        return message.channel.send('Channel not found')
                            .catch(err => console.error('Failed to send response:', err));
                    }
                    
                    await checkChannelPermissions(targetChannel);
                    logMessage(LOG_EVENTS.HASH_START, { 
                        targetChannelId: channelId,
                        commandChannelId: message.channel.id 
                    });
                    
                    const hashDB = await buildHashDatabaseForChannel(targetChannel, message.channel);
                    saveHashDatabase(channelId, hashDB);
                    channelHashTables[channelId] = hashDB;
                    
                } catch (error) {
                    console.error('Hash command error:', error);
                    logMessage('ERROR', { error: error.message, channelId });
                    message.channel.send(`Error: ${error.message}`).catch(console.error);
                }
                break;

            case '!check':
                console.log('Check command processing started');
                const checkChannelId = args[0];
                if (!checkChannelId) {
                    console.log('Check command failed: No channel ID provided');
                    return message.channel.send('Please provide a forum channel ID. Usage: !check <channelId>')
                        .catch(err => console.error('Failed to send response:', err));
                }
                await handleCheckCommand(message, checkChannelId);
                break;

            case '!checkperms':
                console.log('Checkperms command processing started');
                const permsChannelId = args[0];
                if (!permsChannelId) {
                    console.log('Checkperms command failed: No channel ID provided');
                    return message.channel.send('Please provide a channel ID. Usage: !checkperms <channelId>')
                        .catch(err => console.error('Failed to send response:', err));
                }
                try {
                    const channel = await client.channels.fetch(permsChannelId);
                    if (!channel) {
                        return message.channel.send('Channel not found')
                            .catch(err => console.error('Failed to send response:', err));
                    }
                    
                    const permissions = channel.permissionsFor(client.user);
                    const permissionList = ['ViewChannel', 'ReadMessageHistory', 'SendMessages'];
                    const permissionStatus = permissionList.map(perm => 
                        `${perm}: ${permissions.has(perm) ? '✅' : '❌'}`
                    ).join('\n');
                    
                    message.channel.send(`Bot permissions in channel:\n${permissionStatus}`)
                        .catch(err => console.error('Failed to send permissions status:', err));
                } catch (error) {
                    console.error('Checkperms command error:', error);
                    message.channel.send(`Error checking permissions: ${error.message}`)
                        .catch(err => console.error('Failed to send error message:', err));
                }
                break;

            case '!help':
                console.log('Help command processing started');
                const helpMessage = `
**Forum Image Analyzer Bot Commands:**
\`!check <channelId>\` - Analyze a forum channel for duplicate images
\`!checkperms <channelId>\` - Check bot permissions in a forum channel
\`!hash <channelId>\` - Build hash database for previous messages in a channel
\`!help\` - Show this help message

**Note:** All responses will be sent to the channel where the command was issued.
`;
                message.channel.send(helpMessage)
                    .catch(err => console.error('Failed to send help message:', err));
                break;
        }
        return;
    }

    // Handle regular messages with images in tracked channels
    if (TRACKED_CHANNELS.includes(message.channel.id)) {
        const attachments = [...message.attachments.values()];
        const containsImage = attachments.some(att => att.contentType?.startsWith('image/'));
        
        if (!containsImage) return;

        console.log(`Processing new message with images in channel ${message.channel.id}`);
        let hashDB = channelHashTables[message.channel.id] || loadHashDatabase(message.channel.id);

        for (const attachment of attachments) {
            if (!isSupportedImage(attachment)) continue;

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
        duplicates: [],
        attachment: attachment // Save the attachment info
    });
                } else {
                    const entry = hashDB.get(hash);
                    const isSelfRepost = entry.originalMessage.author.id === message.author.id;
                    
                    const embed = new EmbedBuilder()
                        .setTitle(isSelfRepost ? 'SELF-REPOST' : 'DUPE')
                        .setDescription(`[Original message](${entry.originalMessage.url})`)
                        .setColor(isSelfRepost ? 0xFFA500 : 0xFF0000)
                        .setTimestamp();
                    
                    message.reply({ embeds: [embed] })
                        .catch(err => console.error('Failed to send duplicate notification:', err));

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
                console.error('Error processing image:', err);
                logMessage(LOG_EVENTS.IMAGE_ERROR, {
                    messageId: message.id,
                    attachmentUrl: attachment.url,
                    error: err.message
                });
            }
        }

        saveHashDatabase(message.channel.id, hashDB);
        channelHashTables[message.channel.id] = hashDB;
    }
});

const entry = hashDB.get(hash);
    const isSelfRepost = entry.originalMessage.author.id === message.author.id;
    
    // Save the duplicate image information
    entry.duplicates.push({
        id: message.id,
        url: message.url,
        author: {
            username: message.author.username,
            id: message.author.id
        },
        timestamp: message.createdTimestamp,
        channelId: message.channel.id,
        attachment: attachment
    });

    // If this is the first duplicate found, save both original and duplicate
    if (entry.duplicates.length === 1) {
        await saveImageAndDupes(
            entry.attachment,
            [attachment]
        );
    } else {
        // If we already have duplicates, just add the new one to the series
        await saveImageAndDupes(
            entry.attachment,
            entry.duplicates.map(d => d.attachment)
        );
    }

// Error Handlers
client.on(Events.Error, error => {
    console.error('Discord client error:', error);
    logMessage('DISCORD_ERROR', { error: error.message, stack: error.stack });
});

process.on('unhandledRejection', error => {
    console.error('Unhandled promise rejection:', error);
    logMessage('UNHANDLED_REJECTION', { error: error.message, stack: error.stack });
});

process.on('uncaughtException', error => {
    console.error('Uncaught exception:', error);
    logMessage('UNCAUGHT_EXCEPTION', { error: error.message, stack: error.stack });
    process.exit(1);
});

// Bot initialization
if (!process.env.DISCORD_BOT_TOKEN) {
    console.error('No Discord bot token found in environment variables!');
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
        console.error('Failed to log in:', error);
        logMessage('BOT_LOGIN_ERROR', { error: error.message, stack: error.stack });
        process.exit(1);
    });

module.exports = {
    formatElapsedTime,
    getCurrentFormattedTime,
    getImageHash,
    countTotalMessages,
    getAllForumPosts,
    processMessages,
    generateReport,
    checkMemoryUsage,
    isSupportedImage,
    createProgressBar,
    BOT_INFO,
    LOG_CONFIG,
    LOG_EVENTS
};