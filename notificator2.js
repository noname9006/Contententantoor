require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, Partials } = require('discord.js');

// Initialize Discord client with required intents
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
    ],
    partials: [Partials.Message, Partials.Channel, Partials.User]
});

// Constants
const MAX_TEXT_LENGTH = 200;
const ERROR_COLOR = '#f2b518';
const RATE_LIMIT_COOLDOWN = 5000; // 5 seconds
const AUTO_DELETE_TIMER_SECONDS = parseInt(process.env.AUTO_DELETE_TIMER) || 30; // Default to 30 seconds
const AUTO_DELETE_TIMER = AUTO_DELETE_TIMER_SECONDS * 1000; // Convert to milliseconds

// Rate limiting
const rateLimitMap = new Map();

function checkRateLimit(userId) {
    const now = Date.now();
    const userRateLimit = rateLimitMap.get(userId);
    
    if (userRateLimit && now - userRateLimit < RATE_LIMIT_COOLDOWN) {
        return true;
    }
    
    rateLimitMap.set(userId, now);
    return false;
}

// Get formatted UTC timestamp in specific format
function getFormattedTimestamp() {
    return `Current Date and Time (UTC - YYYY-MM-DD HH:MM:SS formatted): ${new Date().toISOString().replace('T', ' ').slice(0, 19)}`;
}

// Environment variable validation
function validateEnvironmentVariables() {
    const requiredVariables = [
        'DISCORD_TOKEN',
        'ROLE_0_ID',
        'ROLE_1_ID',
        'ROLE_2_ID',
        'ROLE_3_ID',
        'ROLE_4_ID',
        'ROLE_5_ID',
        'THREAD_0_ID',
        'THREAD_1_ID',
        'THREAD_2_ID',
        'THREAD_3_ID',
        'THREAD_4_ID',
        'THREAD_5_ID',
        'AUTO_DELETE_TIMER'
    ];

    const missingVariables = requiredVariables.filter(varName => !process.env[varName]);
    if (missingVariables.length > 0) {
        console.log(`Missing environment variables: ${missingVariables.join(', ')}`);
        process.exit(1);
    }

    // Validate Discord IDs
    const idVariables = Object.keys(process.env).filter(key => 
        (key.startsWith('ROLE_') || key.startsWith('THREAD_')) && key.endsWith('_ID')
    );

    idVariables.forEach(varName => {
        const value = process.env[varName];
        if (!/^\d+$/.test(value)) {
            console.log(`Invalid Discord ID format for ${varName}: ${value}`);
            process.exit(1);
        }
    });

    // Validate AUTO_DELETE_TIMER
    const timer = parseInt(process.env.AUTO_DELETE_TIMER);
    if (isNaN(timer) || timer < 0) {
        console.log('Invalid AUTO_DELETE_TIMER value. Must be a positive number of seconds.');
        process.exit(1);
    }
}

// Create mappings for roles and threads
const roleToThread = new Map([
    [process.env.ROLE_0_ID, process.env.THREAD_0_ID],
    [process.env.ROLE_1_ID, process.env.THREAD_1_ID],
    [process.env.ROLE_2_ID, process.env.THREAD_2_ID],
    [process.env.ROLE_3_ID, process.env.THREAD_3_ID],
    [process.env.ROLE_4_ID, process.env.THREAD_4_ID],
    [process.env.ROLE_5_ID, process.env.THREAD_5_ID]
]);

const threadToRole = new Map([
    [process.env.THREAD_0_ID, process.env.ROLE_0_ID],
    [process.env.THREAD_1_ID, process.env.ROLE_1_ID],
    [process.env.THREAD_2_ID, process.env.ROLE_2_ID],
    [process.env.THREAD_3_ID, process.env.ROLE_3_ID],
    [process.env.THREAD_4_ID, process.env.ROLE_4_ID],
    [process.env.THREAD_5_ID, process.env.ROLE_5_ID]
]);

// Create a Set of ignored roles
const ignoredRoles = new Set(
    process.env.IGNORED_ROLES
        ? process.env.IGNORED_ROLES.split(',').map(role => role.trim())
        : []
);

// Cache for thread names
const threadNameCache = new Map();

// Utility function for getting thread name with caching
async function getThreadName(threadId) {
    if (threadNameCache.has(threadId)) {
        return threadNameCache.get(threadId);
    }

    try {
        const channel = await client.channels.fetch(threadId);
        if (!channel) {
            console.log(`Thread ${threadId} not found`);
            return threadId;
        }
        const threadName = channel.name;
        threadNameCache.set(threadId, threadName);
        return threadName;
    } catch (error) {
        console.log(`Error fetching thread ${threadId}: ${error.message}`);
        return threadId;
    }
}

// Check bot permissions in channel
function checkBotPermissions(guild, channel) {
    const botMember = guild.members.cache.get(client.user.id);
    if (!botMember) {
        console.log('Bot member not found in guild');
        return false;
    }

    const requiredPermissions = [
        'ViewChannel',
        'SendMessages',
        'ManageMessages',
        'EmbedLinks'
    ];

    const missingPermissions = requiredPermissions.filter(perm => !botMember.permissions.has(perm));
    if (missingPermissions.length > 0) {
        console.log(`Missing permissions in ${channel.name}: ${missingPermissions.join(', ')}`);
        return false;
    }

    return true;
}

// Event handler for when the bot is ready
client.once('ready', async () => {
    console.log('Bot is ready and online!');
    console.log(`Auto-delete timer set to ${AUTO_DELETE_TIMER_SECONDS} seconds`);
    
    // Initialize thread name cache and log monitored threads
    for (const threadId of threadToRole.keys()) {
        const threadName = await getThreadName(threadId);
        console.log(`Monitoring thread: ${threadName}`);
    }
});

// Main message handler
client.on('messageCreate', async (message) => {
    try {
        // Basic checks
        if (message.author.bot) return;
        if (!message.guild || !message.member) return;
        if (!threadToRole.has(message.channel.id)) return;

        // Rate limit check
        if (checkRateLimit(message.author.id)) {
            console.log(`Rate limit hit for user ${message.author.tag}`);
            return;
        }

        // Permission check
        if (!checkBotPermissions(message.guild, message.channel)) {
            return;
        }

        const threadName = await getThreadName(message.channel.id);

        // Check for ignored roles
        const hasIgnoredRole = message.member.roles.cache.some(role => 
            ignoredRoles.has(role.id)
        );
        if (hasIgnoredRole) {
            return;
        }

        // Check if user has correct role for this thread
        const requiredRoleId = threadToRole.get(message.channel.id);
        const hasCorrectRole = message.member.roles.cache.has(requiredRoleId);

        if (hasCorrectRole) {
            return;
        }

        // Find correct thread for user based on their roles
        let userCorrectThreadId = null;
        for (const [roleId, threadId] of roleToThread) {
            if (message.member.roles.cache.has(roleId)) {
                userCorrectThreadId = threadId;
                break;
            }
        }

        // Prepare embed content
        const hasAttachments = message.attachments.size > 0;
        let embedDescription = hasAttachments 
            ? 'User uploaded file(s)'
            : message.content.length > MAX_TEXT_LENGTH
                ? message.content.substring(0, MAX_TEXT_LENGTH) + '...'
                : message.content || 'No content';

        // Create error embed with exact format
        const errorEmbed = new EmbedBuilder()
            .setColor(ERROR_COLOR)
            .setDescription(`Please use the thread that matches your highest role\nYour message has been removed because it was posted in the wrong thread.`)
            .addFields(
                {
                    name: "Here's the right one for you:",
                    value: userCorrectThreadId
                        ? `<#${userCorrectThreadId}>`
                        : 'No matching thread found for your roles'
                },
                { 
                    name: 'Your message content:', 
                    value: embedDescription
                }
            )
            .setFooter({
                text: 'Botanix Labs',
                iconURL: 'https://a-us.storyblok.com/f/1014909/512x512/026e26392f/dark_512-1.png'
            })
            .setTimestamp();

        try {
            // Send reply and handle message deletion
            const replyMessage = await message.reply({
                embeds: [errorEmbed]
            });

            // Wait briefly before deleting
            await new Promise(resolve => setTimeout(resolve, 500));

            if (message.deletable) {
                await message.delete();
            }

            // Delete reply after the configured time
            if (AUTO_DELETE_TIMER_SECONDS > 0) {
                setTimeout(async () => {
                    try {
                        if (replyMessage.deletable) {
                            await replyMessage.delete();
                        }
                    } catch (deleteError) {
                        console.log(`Failed to delete reply message: ${deleteError.message}`);
                    }
                }, AUTO_DELETE_TIMER);
            }
        } catch (replyError) {
            console.log(`Failed to reply to message: ${replyError.message}`);
            
            // Attempt DM as fallback
            try {
                await message.author.send({
                    embeds: [errorEmbed],
                    content: `Your message in ${threadName} was removed because it was posted in the wrong thread.`
                });

                if (message.deletable) {
                    await message.delete();
                }
            } catch (dmError) {
                console.log(`Failed to notify ${message.author.tag}: ${dmError.message}`);
            }
        }
    } catch (error) {
        console.log(`Error processing message: ${error.message}`);
        console.log(`Error stack: ${error.stack}`);
    }
});

// Error handling
client.on('error', error => {
    console.log(`Client error: ${error.message}`);
});

// Graceful shutdown handling
process.on('SIGINT', () => {
    console.log('Received SIGINT. Shutting down gracefully...');
    client.destroy();
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('Received SIGTERM. Shutting down gracefully...');
    client.destroy();
    process.exit(0);
});

// Validate environment variables before starting
validateEnvironmentVariables();

// Connect to Discord
client.login(process.env.DISCORD_TOKEN).catch(error => {
    console.log(`Failed to login: ${error.message}`);
    process.exit(1);
});