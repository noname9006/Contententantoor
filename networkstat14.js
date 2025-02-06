require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const axios = require('axios');

// Initialize chalk with default values
let chalk = {
    red: (text) => text,
    yellow: (text) => text,
    green: (text) => text,
    cyanBright: (text) => text,
    yellowBright: (text) => text
};

// Async function to initialize chalk
async function initializeChalk() {
    try {
        const chalkModule = await import('chalk');
        chalk = chalkModule.default;
        return true;
    } catch (error) {
        console.error('Failed to load chalk:', error);
        return false;
    }
}

// Main bot initialization and execution
async function startBot() {
    // Initialize chalk first
    await initializeChalk();

    // Environment variables and constants
    const TOKEN = process.env.TOKEN;
    const STATUS_CHANNELS = process.env.STATUS_CHANNEL_ID
        ? process.env.STATUS_CHANNEL_ID.split(',').filter(id => id.trim().length > 0)
        : [];
    const NOTIFICATION_CHANNELS = process.env.NOTIFICATION_CHANNEL_ID
        ? process.env.NOTIFICATION_CHANNEL_ID.split(',').filter(id => id.trim().length > 0)
        : [];
    const STATUS_COMMAND = process.env.STATUS_COMMAND;
    const STATUS_RED_NAME = process.env.STATUS_RED_NAME;
    const STATUS_YELLOW_NAME = process.env.STATUS_YELLOW_NAME;
    const STATUS_GREEN_NAME = process.env.STATUS_GREEN_NAME;
    const FETCH_INTERVAL_RED = parseInt(process.env.FETCH_INTERVAL_RED);
    const FETCH_INTERVAL_YELLOW = parseInt(process.env.FETCH_INTERVAL_YELLOW);
    const FETCH_INTERVAL_GREEN = parseInt(process.env.FETCH_INTERVAL_GREEN);
    const NOTIFICATION_MESSAGE_RED = process.env.NOTIFICATION_MESSAGE_RED;
    const NOTIFICATION_MESSAGE_YELLOW = process.env.NOTIFICATION_MESSAGE_YELLOW;
    const NOTIFICATION_MESSAGE_GREEN = process.env.NOTIFICATION_MESSAGE_GREEN;
    const NOTIFICATION_TIMEOUT = parseInt(process.env.NOTIFICATION_TIMEOUT) * 1000; 
    const STATUS_COMMAND_CHANNELS = process.env.STATUS_COMMAND_CHANNELS
        ? process.env.STATUS_COMMAND_CHANNELS.split(',').filter(id => id.trim().length > 0)
        : [];
    const CUSTOM_MESSAGE_LINE = process.env.CUSTOM_MESSAGE_LINE;

    // Guild Configuration Storage
    const guildConfigs = new Map();

    // State management
    let notificationTimeout = null;
    let recentNotification = null;
    let lastSentNotification = null;
    let currentStatus = '';
    let previousStatus = '';
    let previousStatus_notification = 'status_green';
    let stateChangeTime = null;

    // Utility Functions
    const formatDate = () => {
        return new Date().toISOString().replace('T', ' ').slice(0, 19);
    };

    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    const log = (message, error = false) => {
        const timestamp = formatDate();
        const logMessage = `[${timestamp}] ${message.trim()}`;
        if (error) {
            console.log(chalk.red(logMessage));
        } else {
            console.log(logMessage);
        }
    };

    const logStateChange = (context, details) => {
        const timestamp = formatDate();
        const detailsStr = Object.entries(details)
            .map(([key, value]) => `    ${key}: ${value}`)
            .join('\n');
        log(`[${context}]\n${detailsStr}`);
    };

    // Function to load guild configurations
    const loadGuildConfigs = () => {
        let guildIndex = 1;
        while (true) {
            const guildPrefix = guildIndex === 1 ? 'G1_' : `G${guildIndex}_`;
            const guildId = process.env[`GUILD${guildIndex}`];
            
            if (!guildId || guildId.trim().length === 0) break;
            
            const config = {
                notificationChannelIds: process.env[`${guildPrefix}NOTIFICATION_CHANNEL_ID`]
                    ? process.env[`${guildPrefix}NOTIFICATION_CHANNEL_ID`]
                        .split(',')
                        .map(id => id.trim())
                        .filter(id => id.length > 0)
                    : [],
                statusChannelId: process.env[`${guildPrefix}STATUS_CHANNEL_ID`],
                statusNames: {
                    status_red: process.env[`${guildPrefix}STATUS_RED_NAME`],
                    status_yellow: process.env[`${guildPrefix}STATUS_YELLOW_NAME`],
                    status_green: process.env[`${guildPrefix}STATUS_GREEN_NAME`]
                }
            };

            if (config.statusChannelId || config.notificationChannelIds.length > 0) {
                guildConfigs.set(guildId, config);
                log(`Loaded configuration for Guild ${guildId} with ${config.notificationChannelIds.length} notification channels`);
            }
            
            guildIndex++;
        }
        log(`Loaded configurations for ${guildConfigs.size} guilds`);
    };

    // Function to validate all channels
    const validateAllChannels = async () => {
        log('Starting periodic channel validation...');
        
        // Validate status channels
        for (const channelId of STATUS_CHANNELS) {
            try {
                const channel = await client.channels.fetch(channelId.trim());
                log(`[√] Status channel ${chalk.yellowBright(channel.name)} (${channelId}) validated for Guild ${chalk.cyanBright(channel.guild.name)} (${channel.guild.id})`);
            } catch (error) {
                log(`[×] Invalid status channel ${channelId}: ${error.message}`, true);
            }
        }

        // Validate notification channels
        for (const channelId of NOTIFICATION_CHANNELS) {
            try {
                const channel = await client.channels.fetch(channelId.trim());
                log(`[√] Notification channel ${chalk.yellowBright(channel.name)} (${channelId}) validated for Guild ${chalk.cyanBright(channel.guild.name)} (${channel.guild.id})`);
            } catch (error) {
                log(`[×] Invalid notification channel ${channelId}: ${error.message}`, true);
            }
        }

        // Validate guild-specific channels
        for (const [guildId, config] of guildConfigs.entries()) {
            log(`Validating channels for Guild ${chalk.cyanBright(guildId)}...`);
            
            if (config.statusChannelId) {
                try {
                    const channel = await client.channels.fetch(config.statusChannelId);
                    log(`[√] Guild status channel ${chalk.yellowBright(channel.name)} (${config.statusChannelId}) validated for Guild ${chalk.cyanBright(channel.guild.name)} (${channel.guild.id})`);
                } catch (error) {
                    log(`[×] Invalid guild status channel ${config.statusChannelId} for Guild ${chalk.cyanBright(guildId)}: ${error.message}`, true);
                }
            }

            if (config.notificationChannelIds && config.notificationChannelIds.length > 0) {
                for (const channelId of config.notificationChannelIds) {
                    try {
                        const channel = await client.channels.fetch(channelId);
                        log(`[√] Guild notification channel ${chalk.yellowBright(channel.name)} (${channelId}) validated for Guild ${chalk.cyanBright(channel.guild.name)} (${channel.guild.id})`);
                    } catch (error) {
                        log(`[×] Invalid guild notification channel ${channelId} for Guild ${chalk.cyanBright(guildId)}: ${error.message}`, true);
                    }
                }
            }
        }
        log('Channel validation completed');
    };

    // Initialize Discord client
    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent
        ]
    });

    // API Functions
    const fetchBlocks = async (limit = 11) => {
        try {
            log('Fetching blocks...');
            const response = await axios.get('https://api.routescan.io/v2/network/testnet/evm/3636/blocks?count=false&sort=desc');
            log('Blocks fetched successfully');
            return response.data.items.slice(0, limit);
        } catch (error) {
            log(`Error fetching blocks: ${error.message}`, true);
            return [];
        }
    };

    // Status Management Functions
    const determineStatus = (blocks) => {
        const latestBlock = blocks[0];
        const latestTimestamp = new Date(latestBlock.timestamp);
        const currentTime = new Date();
        const timeDifference = Math.abs(currentTime - latestTimestamp) / 1000;

        const emptyBlockCount = blocks.filter(block => block.txCount === 0).length;

        log(`Time since last block: ${timeDifference.toFixed(2)} seconds`);
        log(`Empty blocks: ${emptyBlockCount}`);

        if (timeDifference > 600) return 'status_red';
        if (timeDifference > 60 || emptyBlockCount > 6) return 'status_yellow';
        return 'status_green';
    };

    const getStatusName = (status, guildId = null) => {
        if (guildId && guildConfigs.has(guildId)) {
            const guildConfig = guildConfigs.get(guildId);
            const guildStatusName = guildConfig.statusNames[status];
            if (guildStatusName) {
                return guildStatusName;
            }
        }

        const statusMap = {
            status_red: STATUS_RED_NAME,
            status_yellow: STATUS_YELLOW_NAME,
            status_green: STATUS_GREEN_NAME
        };
        return statusMap[status] || '';
    };

    const getNotificationMessage = (status) => {
        log(`Getting notification message for status: ${status}`);
        const messageMap = {
            status_red: NOTIFICATION_MESSAGE_RED,
            status_yellow: NOTIFICATION_MESSAGE_YELLOW,
            status_green: NOTIFICATION_MESSAGE_GREEN
        };
        const message = messageMap[status] || '';
        log(`Retrieved message: ${message}`);
        return message;
    };

    // Channel Management Functions
    const setChannelName = async (status) => {
        // Handle global status channels
        for (const channelId of STATUS_CHANNELS) {
            try {
                if (!channelId || typeof channelId !== 'string') {
                    log(`Invalid channel ID: ${channelId}`, true);
                    continue;
                }

                const channel = await client.channels.fetch(channelId.trim());
                if (!channel) {
                    log(`Cannot access channel ${channelId}`, true);
                    continue;
                }

                const newName = getStatusName(status, channel.guild.id);
                if (channel.name !== newName) {
                    await channel.setName(newName);
                    log(`Channel ${chalk.yellowBright(channel.name)} (${channelId}) name updated to: ${newName} (Guild: ${chalk.cyanBright(channel.guild.name)} (${channel.guild.id}))`);
                }
                await sleep(1000);
            } catch (error) {
                log(`Error updating channel ${channelId} name: ${error.message}`, true);
            }
        }

        // Handle guild-specific status channels
        for (const [guildId, config] of guildConfigs.entries()) {
            if (!config.statusChannelId) continue;

            try {
                const channel = await client.channels.fetch(config.statusChannelId);
                if (!channel) {
                    log(`Cannot access guild-specific channel ${config.statusChannelId} for guild ${guildId}`, true);
                    continue;
                }

                const newName = getStatusName(status, guildId);
                if (channel.name !== newName) {
                    await channel.setName(newName);
                    log(`Guild-specific channel ${chalk.yellowBright(channel.name)} (${config.statusChannelId}) name updated to: ${newName} (Guild: ${chalk.cyanBright(channel.guild.name)} (${channel.guild.id}))`);
                }
                await sleep(1000);
            } catch (error) {
                log(`Error updating guild-specific channel for guild ${guildId}: ${error.message}`, true);
            }
        }
    };

    // Notification Functions
    const sendNotification = async (status) => {
        log(`Preparing notification for status: ${status}`);
        const message = getNotificationMessage(status);
        log(`Status message: ${message}`);
        
        const embed = {
            color: getEmbedColor(status),
            title: message,
            footer: {
                text: 'Botanix Labs',
                icon_url: 'https://a-us.storyblok.com/f/1014909/512x512/026e26392f/dark_512-1.png'
            },
            timestamp: new Date()
        };
        
        if (CUSTOM_MESSAGE_LINE) {
            embed.description = 'Block explorer: ' + CUSTOM_MESSAGE_LINE;
        }

        // Send to global notification channels
        for (const channelId of NOTIFICATION_CHANNELS) {
            try {
                if (!channelId || typeof channelId !== 'string') {
                    log(`Invalid channel ID: ${channelId}`, true);
                    continue;
                }

                const channel = await client.channels.fetch(channelId.trim());
                if (!channel || !channel.send) {
                    log(`Cannot access channel or send messages to ${channelId}`, true);
                    continue;
                }

                await channel.send({ embeds: [embed] });
                log(`Notification sent to channel ${chalk.yellowBright(channel.name)} (${channelId}) (Guild: ${chalk.cyanBright(channel.guild.name)} (${channel.guild.id}))`);
                await sleep(1000);
            } catch (error) {
                log(`Failed to send to channel ${channelId}: ${error.message}`, true);
            }
        }

        // Send to guild-specific notification channels
        for (const [guildId, config] of guildConfigs.entries()) {
            if (!config.notificationChannelIds || config.notificationChannelIds.length === 0) continue;

            for (const channelId of config.notificationChannelIds) {
                try {
                    const channel = await client.channels.fetch(channelId);
                    if (!channel || !channel.send) {
                        log(`Cannot access guild-specific notification channel ${channelId} for guild ${guildId}`, true);
                        continue;
                    }

                    await channel.send({ embeds: [embed] });
                    log(`Notification sent to guild-specific channel ${chalk.yellowBright(channel.name)} (${channelId}) (Guild: ${chalk.cyanBright(channel.guild.name)} (${channel.guild.id}))`);
                    await sleep(1000);
                } catch (error) {
                    log(`Failed to send to guild-specific channel ${channelId} for guild ${guildId}: ${error.message}`, true);
                }
            }
        }
    };

     // Helper function for embed colors
    const getEmbedColor = (status) => {
        const colorMap = {
            status_red: 0xFF0000,    // Red
            status_yellow: 0xFFFF00,  // Yellow
            status_green: 0x00FF00    // Green
        };
        return colorMap[status] || 0xFFFFFF;
    };

    // Status Check Function
    const checkStatus = async () => {
        const blocks = await fetchBlocks();
        if (blocks.length < 11) {
            log('Insufficient blocks fetched');
            return FETCH_INTERVAL_RED;
        }

        const newStatus = determineStatus(blocks);
        const currentTime = new Date();

        const logStatus = (status) => {
            if (!status) return 'undefined';
            if (status === 'status_red') return chalk.red(status);
            if (status === 'status_yellow') return chalk.yellow(status);
            return chalk.green(status);
        };

        logStateChange('STATUS_CHECK', {
            'New Status': logStatus(newStatus),
            'Current Status': logStatus(currentStatus),
            'Previous Status': logStatus(previousStatus),
            'Recent Notification': logStatus(recentNotification),
            'Last Sent Notification': logStatus(lastSentNotification),
            'Notification Timeout Active': notificationTimeout !== null,
            'Time Since Last State Change': stateChangeTime ? `${(currentTime - stateChangeTime) / 1000}s` : 'N/A'
        });

        await setChannelName(newStatus);

        if (lastSentNotification === null) {
            lastSentNotification = newStatus;
            log(`Initialized lastSentNotification to: ${logStatus(lastSentNotification)}`);
        }

        if (newStatus !== currentStatus && previousStatus !== '') {
            logStateChange('STATUS_CHANGE_DETECTED', {
                'From': logStatus(currentStatus),
                'To': logStatus(newStatus),
                'Time': formatDate()
            });
            
            stateChangeTime = currentTime;

            if (notificationTimeout) {
                clearTimeout(notificationTimeout);
                log('Previous notification timeout cleared');
            }

            recentNotification = newStatus;
            
            if (recentNotification !== lastSentNotification) {
                log('Setting notification timeout - status has changed');
                notificationTimeout = setTimeout(async () => {
                    if (recentNotification && recentNotification !== lastSentNotification) {
                        await sendNotification(recentNotification);
                        previousStatus_notification = currentStatus;
                        lastSentNotification = recentNotification;
                        log(`Last sent notification updated to: ${logStatus(recentNotification)}`);
                        recentNotification = null;
                    }
                }, NOTIFICATION_TIMEOUT);
            } else {
                log('Notification skipped - status matches last sent notification');
                recentNotification = null;
            }
        }

        previousStatus = currentStatus;
        currentStatus = newStatus;

        const intervals = {
            status_red: FETCH_INTERVAL_RED,
            status_yellow: FETCH_INTERVAL_YELLOW,
            status_green: FETCH_INTERVAL_GREEN
        };

        const fetchInterval = intervals[newStatus];
        log(`Next check in ${fetchInterval / 1000} seconds`);
        return fetchInterval;
    };

    // Command Handler Function
    const handleStatusCommand = async (message) => {
        try {
            if (!message || !message.channel || typeof message.channel.send !== 'function') {
                log('Invalid message object or channel', true);
                return;
            }

            const blocks = await fetchBlocks(100);
            if (blocks.length === 0) {
                await message.channel.send({
                    embeds: [{
                        color: 0xFF0000,
                        title: 'Error',
                        description: 'No blocks fetched.',
                        timestamp: new Date()
                    }]
                });
                return;
            }

            const networkStatus = determineStatus(blocks);
            const lastBlock = blocks[0];
            
            const timeDiffs = blocks.slice(1).map((block, i) => {
                const prevBlockTime = new Date(blocks[i].timestamp);
                const currentBlockTime = new Date(block.timestamp);
                return (prevBlockTime - currentBlockTime) / 1000;
            });
            
            const latestBlockTime = new Date(lastBlock.timestamp);
            const currentTime = new Date();
            const blockAge = Math.floor((currentTime - latestBlockTime) / 1000);

            timeDiffs.push(blockAge);
            const avgBlockTime = timeDiffs.reduce((a, b) => a + b, 0) / timeDiffs.length;

            const emptyBlockCount = blocks.filter(block => block.txCount === 0).length;
            const emptyBlocksPercentage = ((emptyBlockCount / blocks.length) * 100).toFixed(0);

            const statusInfo = {
                status_red: { emoji: '🚫', color: 0xFF0000 },
                status_yellow: { emoji: '⚠️', color: 0xFFFF00 },
                status_green: { emoji: '✅', color: 0x00FF00 }
            };

            await message.channel.send({
                embeds: [{
                    color: statusInfo[networkStatus].color,
                    title: `${getNotificationMessage(networkStatus)}`,
                    description: `Latest block: #${lastBlock.number}, ${lastBlock.txCount} tx, age: ${blockAge} seconds\n\u200B`,
                    fields: [
                        {
                            name: 'Blocks\nanalyzed',
                            value: `${blocks.length}\n \n`,
                            inline: true
                        },
                        {
                            name: 'Empty\nblocks',
                            value: `${emptyBlockCount} (${emptyBlocksPercentage}%)\n \n`,
                            inline: true
                        },
                        {
                            name: 'Avg\nblock time',
                            value: `${avgBlockTime.toFixed(2)} seconds`,
                            inline: true
                        },
                        {
                            name: '\u200B',
                            value: '\n\n',
                            inline: false
                        },
                        {
                            name: 'Block explorer:',
                            value: `${CUSTOM_MESSAGE_LINE}`,
                            inline: false
                        }
                    ],
                    footer: {
                        text: 'Botanix Labs',
                        icon_url: 'https://a-us.storyblok.com/f/1014909/512x512/026e26392f/dark_512-1.png'
                    },
                    timestamp: new Date()
                }]
            });
        } catch (error) {
            log(`Command error: ${error.message}`, true);
            if (message && message.channel && typeof message.channel.send === 'function') {
                await message.channel.send({
                    embeds: [{
                        color: 0xFF0000,
                        title: 'Error',
                        description: 'Error processing request.',
                        timestamp: new Date()
                    }]
                });
            }
        }
    };

    // Event Handlers
    client.once('ready', async () => {
        log(`Logged in as ${client.user.tag}`);
        
        // Load guild configurations
        loadGuildConfigs();
        
        // Initial channel validation
        await validateAllChannels();

        // Set up periodic channel validation (every 24 hours)
        setInterval(validateAllChannels, 24 * 60 * 60 * 1000);

        let fetchInterval = await checkStatus();
        setInterval(async () => {
            try {
                fetchInterval = await checkStatus();
            } catch (error) {
                log(`Error in status check interval: ${error.message}`, true);
                fetchInterval = FETCH_INTERVAL_RED;
            }
        }, fetchInterval);
    });

    client.on('messageCreate', async (message) => {
        if (message.content.trim() === STATUS_COMMAND && 
            STATUS_COMMAND_CHANNELS.includes(message.channel.id)) {
            await handleStatusCommand(message);
        }
    });

    // Error Handling
    client.on('error', error => {
        log(`Client error: ${error.message}`, true);
    });

    process.on('unhandledRejection', error => {
        log(`Unhandled rejection: ${error.message}`, true);
    });

    process.on('uncaughtException', error => {
        log(`Uncaught exception: ${error.message}`, true);
        client.destroy();
        process.exit(1);
    });

    // Graceful shutdown handling
    process.on('SIGINT', () => {
        log('Received SIGINT. Performing graceful shutdown...');
        client.destroy();
        process.exit(0);
    });

    process.on('SIGTERM', () => {
        log('Received SIGTERM. Performing graceful shutdown...');
        client.destroy();
        process.exit(0);
    });

    // Start the bot
    try {
        await client.login(TOKEN);
    } catch (error) {
        log(`Login failed: ${error.message}`, true);
        process.exit(1);
    }
}

// Start the bot with error handling
startBot().catch(error => {
    console.error('Failed to start bot:', error);
    process.exit(1);
});