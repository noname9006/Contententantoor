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

// Create a Set of ignored roles for easier checking
const ignoredRoles = new Set(
    process.env.IGNORED_ROLES
        ? process.env.IGNORED_ROLES.split(',').map(role => role.trim())
        : []
);

client.once('ready', () => {
    console.log('Bot is ready!');
});

client.on('messageCreate', async (message) => {
    // Ignore bot messages
    if (message.author.bot) return;

    // Check if message is in one of our monitored threads
    if (!threadToRole.has(message.channel.id)) return;

    // Check if user has any ignored roles
    const hasIgnoredRole = message.member.roles.cache.some(role => 
        ignoredRoles.has(role.id)
    );

    // If user has an ignored role, allow them to post anywhere
    if (hasIgnoredRole) return;

    // Get the required role for this thread
    const requiredRoleId = threadToRole.get(message.channel.id);
    
    // Check if user has the correct role
    const hasCorrectRole = message.member.roles.cache.has(requiredRoleId);

    if (!hasCorrectRole) {
        // Find the correct thread for the user
        let userCorrectThreadId = null;
        for (const [roleId, threadId] of roleToThread) {
            if (message.member.roles.cache.has(roleId)) {
                userCorrectThreadId = threadId;
                break;
            }
        }

        // Create embedded message
        const errorEmbed = new EmbedBuilder()
            .setColor('#FF0000')
            .setTitle('Wrong Thread')
            .setDescription('You\'ve posted in the wrong thread!')
            .addFields(
                { name: 'Your Message', value: message.content },
                { 
                    name: 'Correct Thread', 
                    value: userCorrectThreadId 
                        ? `<#${userCorrectThreadId}>`
                        : 'No matching thread found for your roles'
                }
            )
            .setTimestamp();

        try {
            // Send ephemeral reply
            await message.reply({ 
                embeds: [errorEmbed], 
                ephemeral: true 
            });

            // Delete the original message
            await message.delete();
        } catch (error) {
            console.error('Error handling wrong thread message:', error);
        }
    }
});

client.login(process.env.DISCORD_TOKEN);