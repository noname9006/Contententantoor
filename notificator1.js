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
    partials: [Partials.Message, Partials.Channel]
});

// Constants
const MAX_TEXT_LENGTH = 200;
const ERROR_COLOR = '#f2b518';
const SUCCESS_COLOR = '#f2b518';

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
        const threadName = channel ? channel.name : threadId;
        threadNameCache.set(threadId, threadName);
        return threadName;
    } catch (error) {
        return threadId;
    }
}

// Utility function for logging with timestamp
function logWithTimestamp(message, type = 'INFO') {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [${type}] ${message}`);
}

// Event handler for when the bot is ready
client.once('ready', async () => {
    logWithTimestamp('Bot is ready and online!', 'STARTUP');
    
    // Initialize thread name cache and log monitored threads
    for (const threadId of threadToRole.keys()) {
        const threadName = await getThreadName(threadId);
        logWithTimestamp(`Monitoring thread: ${threadName}`, 'CONFIG');
    }
});

// Main message handler
client.on('messageCreate', async (message) => {
    // Immediately return if message is from a bot - no logging
    if (message.author.bot) return;

    // Early exit if not in monitored thread
    if (!threadToRole.has(message.channel.id)) return;

    const threadName = await getThreadName(message.channel.id);

    // Log message receipt in monitored channel
    logWithTimestamp(`Message received in "${threadName}" from ${message.author.tag}`, 'MESSAGE');

    // Check for ignored roles
    const hasIgnoredRole = message.member.roles.cache.some(role => 
        ignoredRoles.has(role.id)
    );
    if (hasIgnoredRole) {
        logWithTimestamp(`User ${message.author.tag} has an ignored role - message allowed in "${threadName}"`, 'ROLE');
        return;
    }

    // Check if user has correct role for this thread
    const requiredRoleId = threadToRole.get(message.channel.id);
    const hasCorrectRole = message.member.roles.cache.has(requiredRoleId);

    if (hasCorrectRole) {
        logWithTimestamp(`User ${message.author.tag} has correct role for "${threadName}"`, 'ACCESS');
        return;
    }

    // Find correct thread for user based on their roles
    let userCorrectThreadId = null;
    let userCorrectThreadName = null;
    for (const [roleId, threadId] of roleToThread) {
        if (message.member.roles.cache.has(roleId)) {
            userCorrectThreadId = threadId;
            userCorrectThreadName = await getThreadName(threadId);
            break;
        }
    }

    // Prepare embed content
    const hasAttachments = message.attachments.size > 0;
    let embedDescription = hasAttachments 
        ? 'User uploaded file(s). (Omitting file content in embed.)'
        : message.content.length > MAX_TEXT_LENGTH
            ? 'Message content is too long. (Omitting full content.)'
            : message.content;

    // Create error embed
    const errorEmbed = new EmbedBuilder()
        .setColor(ERROR_COLOR)
        .setTitle('Wrong Thread')
        .setDescription("You've posted in the wrong thread!")
        .addFields(
            { name: 'Your Message', value: embedDescription },
            {
                name: 'Correct Thread',
                value: userCorrectThreadId
                    ? `<#${userCorrectThreadId}> (${userCorrectThreadName})`
                    : 'No matching thread found for your roles'
            }
        )
        .setTimestamp();

    try {
        // First try to send as a reply with ephemeral flag
        const reply = await message.reply({
            embeds: [errorEmbed],
            ephemeral: true
        });

        // Delete the original message
        await message.delete();
        
        logWithTimestamp(`Notification sent to ${message.author.tag} about wrong thread usage`, 'WARNING');
        logWithTimestamp(`Deleted message from ${message.author.tag} in "${threadName}"`, 'MODERATION');
    } catch (error) {
        // If reply fails, try sending as DM
        try {
            await message.author.send({
                embeds: [errorEmbed],
                content: `Your message in ${threadName} was removed because it was posted in the wrong thread.`
            });
            await message.delete();
            logWithTimestamp(`Sent DM to ${message.author.tag} (reply failed)`, 'WARNING');
        } catch (dmError) {
            logWithTimestamp(`Failed to notify ${message.author.tag}: ${dmError.message}`, 'ERROR');
        }
    }
});

// Error handling for the client
client.on('error', error => {
    logWithTimestamp(`Client error: ${error.message}`, 'ERROR');
});

// Handle Discord API rate limits
client.on('rateLimit', (rateLimitInfo) => {
    logWithTimestamp(`Rate limit hit: ${rateLimitInfo.route}`, 'RATELIMIT');
});

// Graceful shutdown handling
process.on('SIGINT', () => {
    logWithTimestamp('Received SIGINT. Shutting down gracefully...', 'SHUTDOWN');
    client.destroy();
    process.exit(0);
});

process.on('SIGTERM', () => {
    logWithTimestamp('Received SIGTERM. Shutting down gracefully...', 'SHUTDOWN');
    client.destroy();
    process.exit(0);
});

// Connect to Discord
client.login(process.env.DISCORD_TOKEN).catch(error => {
    logWithTimestamp(`Failed to login: ${error.message}`, 'FATAL');
    process.exit(1);
});