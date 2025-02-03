require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, Partials } = require('discord.js');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
    ],
    partials: [Partials.Message, Partials.Channel]
});

// Create mappings for roles and threads (update these lines with your own environment variables or hard-coded IDs as needed)
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

// Create a Set of ignored roles for easier checking
const ignoredRoles = new Set(
    process.env.IGNORED_ROLES
        ? process.env.IGNORED_ROLES.split(',').map(role => role.trim())
        : []
);

// Adjust this length to control how much text can be embedded
const MAX_TEXT_LENGTH = 200;

client.once('ready', () => {
    console.log('Bot is ready!');
});

client.on('messageCreate', async (message) => {
    // Log that a message was received, but do not log its content
    console.log(`Received message in channel ${message.channel.id} from ${message.author.tag}.`);

    // Ignore bot messages
    if (message.author.bot) {
        console.log('Ignoring bot message.');
        return;
    }

    // Check if message is in one of our monitored threads
    if (!threadToRole.has(message.channel.id)) {
        console.log(`Channel ${message.channel.id} is not monitored.`);
        return;
    }

    // Check if user has any ignored roles
    const hasIgnoredRole = message.member.roles.cache.some(role =>
        ignoredRoles.has(role.id)
    );
    if (hasIgnoredRole) {
        console.log(`${message.author.tag} has an ignored role. Allowing message to pass.`);
        return;
    }

    // Get the required role for this thread
    const requiredRoleId = threadToRole.get(message.channel.id);
    // Check if user has the correct role
    const hasCorrectRole = message.member.roles.cache.has(requiredRoleId);
    if (hasCorrectRole) {
        console.log(`${message.author.tag} has the correct role for channel ${message.channel.id}.`);
        return;
    }

    // User does not have the correct role
    console.log(`${message.author.tag} does not have the correct role for channel ${message.channel.id}.`);

    // Find the correct thread for the user
    let userCorrectThreadId = null;
    for (const [roleId, threadId] of roleToThread) {
        if (message.member.roles.cache.has(roleId)) {
            userCorrectThreadId = threadId;
            break;
        }
    }

    // Check attachments (skip embedding them)
    const hasAttachments = message.attachments.size > 0;

    // Check message length before embedding
    let embedDescription = '[Content omitted]'; // Default placeholder
    if (hasAttachments) {
        // If there are attachments, skip including them in the embed
        embedDescription = 'User uploaded file(s). (Omitting file content in embed.)';
    } else {
        // If text is too long, use a placeholder
        embedDescription = message.content.length > MAX_TEXT_LENGTH
            ? 'Message content is too long. (Omitting full content.)'
            : message.content;
    }

    // Build the embed
    const errorEmbed = new EmbedBuilder()
        .setColor('#FF0000')
        .setTitle('Wrong Thread')
        .setDescription("You've posted in the wrong thread!")
        .addFields(
            { name: 'Your Message', value: embedDescription },
            {
                name: 'Correct Thread',
                value: userCorrectThreadId
                    ? `<#${userCorrectThreadId}>`
                    : 'No matching thread found for your roles'
            }
        )
        .setTimestamp();

    try {
        // Send ephemeral reply with the embed
        await message.reply({
            embeds: [errorEmbed],
            ephemeral: true
        });
        console.log(`Sent warning message to ${message.author.tag}.`);

        // Delete the original message
        await message.delete();
        console.log(`Deleted message from ${message.author.tag}.`);
    } catch (error) {
        console.error('Error handling wrong thread message:', error);
    }
});

client.login(process.env.DISCORD_TOKEN);