const { Client, Events, GatewayIntentBits } = require('discord.js');
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
        GatewayIntentBits.GuildMessageReactions
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

// Function to count total messages in the channel
async function countTotalMessages(channel) {
    let totalMessages = 0;
    let lastMessageId;
    const batchSize = 100;

    while (true) {
        const options = { limit: batchSize };
        if (lastMessageId) options.before = lastMessageId;

        const messages = await channel.messages.fetch(options);
        if (messages.size === 0) break;

        totalMessages += messages.size;
        lastMessageId = messages.last().id;
    }

    return totalMessages;
}

// Function to generate CSV report
async function generateReport(channelId, imageDatabase) {
    const fileName = `duplicate_report_${channelId}_${Date.now()}.csv`;
    const writeStream = fs.createWriteStream(fileName);

    // Write header
    writeStream.write(
        `# Analysis performed by: ${BOT_INFO.operator}\n` +
        `# Analysis start time: ${BOT_INFO.startTime} UTC\n` +
        `# Report generated at: ${getCurrentFormattedTime()} UTC\n\n` +
        'Original Message Link,Original Poster,Number of Duplicates,Users Who Reposted,Stolen Reposts,Self-Reposts\n'
    );

    // Process entries
    for (const [hash, imageInfo] of imageDatabase.entries()) {
        const allPosters = [imageInfo.originalMessage, ...imageInfo.duplicates];
        allPosters.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

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

        const line = `${originalPoster.url},${originalPoster.author.username},` +
                     `${reposts.length},${reposts.map(d => d.author.username).join(';')},` +
                     `${stolenCount},${selfRepostCount}\n`;
        writeStream.write(line);
    }

    await new Promise(resolve => writeStream.end(resolve));
    return fileName;
}

// Command handler
async function handleCheckCommand(message, channelId) {
    const commandStartTime = Date.now();
    try {
        const initialMemory = checkMemoryUsage();
        
        const channel = await client.channels.fetch(channelId);
        if (!channel) {
            logMessage('CHANNEL_NOT_FOUND', { channelId });
            return message.reply('Invalid channel ID provided.');
        }

        const statusMessage = await message.reply('Starting channel analysis... This might take a while.');
        logMessage('MESSAGE_SENT', { content: 'Starting channel analysis... This might take a while.' }, formatElapsedTime((Date.now() - commandStartTime) / 1000));

        // Clear previous data and run garbage collection
        imageDatabase.clear();
        if (global.gc) {
            global.gc();
        }

        // Count total messages in the channel
        const totalMessages = await countTotalMessages(channel);
        logMessage('TOTAL_MESSAGES', { totalMessages });
        
        await statusMessage.edit(`Starting analysis of ${totalMessages} total messages... This might take a while.`);

        let processedMessages = 0;
        let processedImages = 0;
        let duplicatesFound = 0;
        let lastMessageId;
        let batchSize = 100;
        let startTime = Date.now();
        let timeEstimates = [];

        while (true) {
            const currentMemory = checkMemoryUsage();
            
            if (currentMemory > (BOT_INFO.memoryLimit * 0.8)) {
                batchSize = Math.max(10, Math.floor(batchSize * 0.5));
            }

            const options = { limit: batchSize };
            if (lastMessageId) options.before = lastMessageId;
            
            const messages = await channel.messages.fetch(options);
            if (messages.size === 0) break;

            for (const msg of messages.values()) {
                const attachments = [...msg.attachments.values()];
                
                for (const attachment of attachments) {
                    if (attachment.contentType?.startsWith('image/')) {
                        if (checkMemoryUsage() > (BOT_INFO.memoryLimit * 0.9)) {
                            if (global.gc) {
                                global.gc();
                                await new Promise(resolve => setTimeout(resolve, 1000));
                            }
                        }

                        processedImages++;
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
                                    timestamp: msg.createdTimestamp
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
                                timestamp: msg.createdTimestamp
                            });
                        }
                    }
                }
            }
            
            processedMessages += messages.size;
            lastMessageId = messages.last().id;

            if (processedMessages % 100 === 0) {
                const currentTime = Date.now();
                const elapsedTime = (currentTime - startTime) / 1000;
                const totalElapsedTime = (currentTime - commandStartTime) / 1000;
                timeEstimates.push(elapsedTime);
                const avgTimePer100 = timeEstimates.reduce((a, b) => a + b, 0) / timeEstimates.length;
                const remainingMessages = totalMessages - processedMessages;
                const estimatedTimeLeft = (remainingMessages / 100) * avgTimePer100;

                messages.clear();
                if (global.gc) {
                    global.gc();
                }

                const statusUpdate = `Processing... Analyzed ${processedMessages}/${totalMessages} messages, ` +
                                   `${processedImages} images, found ${duplicatesFound} duplicates. ` +
                                   `Estimated time left: ${formatElapsedTime(estimatedTimeLeft)}. ` +
                                   `Average time per 100 messages: ${formatElapsedTime(avgTimePer100)}. ` +
                                   `Elapsed time: ${formatElapsedTime(totalElapsedTime)}.`;
                await statusMessage.edit(statusUpdate);
                logMessage('MESSAGE_SENT', { content: statusUpdate }, formatElapsedTime(totalElapsedTime));

                startTime = currentTime;
            }
        }

        const fileName = await generateReport(channelId, imageDatabase);

        // Clear the database to free memory
        imageDatabase.clear();
        if (global.gc) {
            global.gc();
        }

        const finalStats = {
            totalMessages: totalMessages,
            processedMessages: processedMessages,
            totalImages: processedImages,
            uniqueImages: imageDatabase.size,
            totalDuplicates: duplicatesFound,
            finalMemoryMB: checkMemoryUsage()
        };

        const totalElapsedTime = (Date.now() - commandStartTime) / 1000;
        const finalMessage = `Analysis complete!\n` +
                           `Total messages in channel: ${finalStats.totalMessages}\n` +
                           `Messages processed: ${finalStats.processedMessages}\n` +
                           `Total images: ${finalStats.totalImages}\n` +
                           `Unique images: ${finalStats.uniqueImages}\n` +
                           `Duplicates found: ${finalStats.totalDuplicates}\n` +
                           `Elapsed time: ${formatElapsedTime(totalElapsedTime)}`;
        await message.reply({
            content: finalMessage,
            files: [fileName]
        });
        logMessage('MESSAGE_SENT', { content: finalMessage }, formatElapsedTime(totalElapsedTime));

        // Cleanup
        fs.unlinkSync(fileName);
        
        logMessage('COMMAND_COMPLETE', {
            totalMessages: totalMessages,
            processedMessages: processedMessages,
            totalImages: processedImages,
            uniqueImages: imageDatabase.size,
            totalDuplicates: duplicatesFound
        });

    } catch (error) {
        const totalElapsedTime = (Date.now() - commandStartTime) / 1000;
        const errorMessage = 'An error occurred while processing the command.';
        logMessage('ERROR', {
            error: error.message,
            stack: error.stack,
            channelId,
            memoryUsageMB: checkMemoryUsage()
        });
        logMessage('MESSAGE_SENT', { content: errorMessage }, formatElapsedTime(totalElapsedTime));
        
        message.reply(errorMessage);
    }
}

// Event handlers
client.once(Events.ClientReady, c => {
    logMessage('BOT_STARTUP', {
        username: c.user.tag,
        operator: BOT_INFO.operator,
        startTime: BOT_INFO.startTime,
        guilds: c.guilds.cache.size
    });
});

client.on(Events.MessageCreate, async message => {
    if (message.author.bot) return;

    if (message.content.startsWith('!check')) {
        const channelId = message.content.split(' ')[1];
        if (!channelId) {
            const errorMessage = 'Please provide a channel ID. Usage: !check <channelId>';
            logMessage('INVALID_COMMAND', {
                command: message.content,
                author: message.author.username,
                reason: 'Missing channel ID'
            });
            logMessage('MESSAGE_SENT', { content: errorMessage }, null);
            return message.reply(errorMessage);
        }
        await handleCheckCommand(message, channelId);
    }
});

client.on(Events.Error, (error) => {
    const errorMessage = 'A Discord error occurred.';
    logMessage('DISCORD_ERROR', {
        error: error.message,
        stack: error.stack,
        currentMemoryMB: checkMemoryUsage()
    });
    logMessage('MESSAGE_SENT', { content: errorMessage }, null);
});

// Check for token and login
if (!process.env.DISCORD_BOT_TOKEN) {
    const errorMessage = 'No Discord bot token found in environment variables!';
    logMessage('STARTUP_ERROR', {
        error: errorMessage,
        currentMemoryMB: checkMemoryUsage()
    });
    logMessage('MESSAGE_SENT', { content: errorMessage }, null);
    process.exit(1);
}

client.login(process.env.DISCORD_BOT_TOKEN);