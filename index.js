require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');

const token = process.env.BOT_TOKEN;
const bot = new TelegramBot(token, { polling: true });

const adminIds = process.env.ADMIN_IDS.split(',').map(id => parseInt(id.trim())); // массив ID админов
const groupChatId = parseInt(process.env.GROUP_CHANNEL_ID);

let waitingForMessage = false;
let broadcastMessage = '';
let participants = new Map(); // userId -> имя
let groupMessageId = null;

// Проверка, является ли пользователь админом
function isAdmin(userId) {
    return adminIds.includes(userId);
}

// Команда /start от админа
bot.onText(/\/start/, (msg) => {
    if (isAdmin(msg.from.id)) {
        bot.sendMessage(msg.from.id, 'Выберите действие:', {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '📝 Новая игра', callback_data: 'new_broadcast' }],
                    [{ text: '📋 Участники', callback_data: 'show_participants' }],
                    [{ text: '❌ Отменить игру', callback_data: 'cancel_game' }],
                    [{ text: '✅ Зал забронирован', callback_data: 'hall_reserved' }]
                ]
            }
        });
    }
});

// Получение текста от админа
bot.on('message', (msg) => {
    if (!isAdmin(msg.from.id) || msg.text.startsWith('/')) return;

    if (waitingForMessage) {
        broadcastMessage = msg.text;
        waitingForMessage = false;

        bot.sendMessage(msg.from.id, `Вы ввели:\n\n${broadcastMessage}\n\nОтправить?`, {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '🚀 Старт', callback_data: 'start_broadcast' }]
                ]
            }
        });
    }
});

// Обработка кнопок
bot.on('callback_query', async (query) => {
    const userId = query.from.id;
    const fullName = `${query.from.first_name || ''} ${query.from.last_name || ''}`.trim();

    if (!query.data) return;

    if (query.data === 'new_broadcast') {
        if (groupMessageId !== null) {
            await bot.answerCallbackQuery(query.id, {
                text: '⚠️ Игра уже создана. Сначала отмените текущую.',
                show_alert: true
            });
            return;
        }
    
        bot.sendMessage(userId, 'Введите сообщение для рассылки:');
        waitingForMessage = true;
        return;
    }

    // Запуск рассылки
    if (query.data === 'start_broadcast' && isAdmin(userId)) {
        participants.clear();
        const text = `${broadcastMessage}\n\n📝 Участники:\n_никто ещё не записался_`;

        const sent = await bot.sendMessage(groupChatId, text, {
            parse_mode: 'Markdown',
            reply_markup: generateButtons()
        });

        groupMessageId = sent.message_id;

        try {
            await bot.sendMessage(userId, '✅ Сообщение отправлено в группу.');
        } catch (err) {
            console.error(`Не удалось отправить сообщение админу ${userId}: ${err.message}`);
        }
        return;
    }

    // Запись пользователя
    if (query.data === 'signup' && userId) {
        let actionText = '';
        if (participants.has(userId)) {
            actionText = '❌ Вы уже записаны!';
        } else {
            participants.set(userId, fullName);
            actionText = '✅ Вы записались!';
        }

        await bot.answerCallbackQuery(query.id, { text: actionText });
        await updateParticipantMessage();
    }

    // Отмена записи
    if (query.data === 'cancel_signup' && userId) {
        let actionText = '';
        if (participants.has(userId)) {
            participants.delete(userId);
            actionText = '✅ Вы отменили запись.';
        } else {
            actionText = '❌ Вы не записаны!';
        }

        await bot.answerCallbackQuery(query.id, { text: actionText });
        await updateParticipantMessage();
    }

    // Подтверждение оплаты пользователем
    if (query.data === 'confirm_self_payment') {
        if (!participants.has(userId)) {
            await bot.answerCallbackQuery(query.id, {
                text: 'Вы не записаны.',
                show_alert: true
            });
            return;
        }

        let name = participants.get(userId);
        if (!name.includes('💰')) {
            name += ' 💰';
            participants.set(userId, name);

            for (const adminId of adminIds) {
                try {
                    await bot.sendMessage(adminId, `💸 ${name} подтвердил(а) оплату.`);
                } catch (err) {
                    console.error(`Не удалось отправить сообщение админу ${adminId}: ${err.message}`);
                }
            }
        }

        await bot.answerCallbackQuery(query.id, { text: '✅ Оплата отмечена. Спасибо!' });
        await updateParticipantMessage();
    }

    // Показ списка участников админу
    if (query.data === 'show_participants' && isAdmin(userId)) {
        const list = Array.from(participants.values());
        const participantText = list.length
            ? list.map((name, i) => `${i + 1}. ${name}`).join('\n')
            : 'Никто не записался.';

        try {
            await bot.sendMessage(userId, `📋 Участники:\n\n${participantText}`);
        } catch (err) {
            console.error(`Не удалось отправить список участников админу ${userId}: ${err.message}`);
        }
    }

    // Отмена игры
    if (query.data === 'cancel_game' && isAdmin(userId)) {
    try {
        await bot.sendMessage(groupChatId, '🚫 Игра отменена администратором.');
        participants.clear();
        groupMessageId = null; // сброс
    } catch (err) {
        console.error('Ошибка при отмене игры:', err.message);
    }
}

    // Зал забронирован
    if (query.data === 'hall_reserved' && isAdmin(userId)) {
        try {
            const list = Array.from(participants.entries()).map(([id, name], i) => `${i + 1}. ${name}`);
            const participantText = list.length ? list.join('\n') : '_никто ещё не записался_';
            const text = `*ЗАЛ ЗАБРОНИРОВАН*\n\n${broadcastMessage}\n\n📝 Участники:\n${participantText}`;

            const sent = await bot.sendMessage(groupChatId, text, {
                parse_mode: 'Markdown',
                reply_markup: generateButtons()
            });
            groupMessageId = sent.message_id;
        } catch (err) {
            console.error('Ошибка при отправке сообщения о зале:', err.message);
        }
    }
});

// Генерация клавиатуры
function generateButtons() {
    return {
        inline_keyboard: [
            [{ text: '✅ Записаться', callback_data: 'signup' }],
            [{ text: '❌ Отменить запись', callback_data: 'cancel_signup' }],
            [{ text: '💰 Я оплатил', callback_data: 'confirm_self_payment' }]
        ]
    };
}

// Обновление списка участников
async function updateParticipantMessage() {
    try {
        const list = Array.from(participants.entries()).map(([id, name], index) => {
            return `${index + 1}. ${name}`;
        });

        const participantText = list.length ? list.join('\n') : '_никто ещё не записался_';
        const updatedMessage = `${broadcastMessage}\n\n📝 Участники:\n${participantText}`;

        await bot.editMessageText(updatedMessage, {
            chat_id: groupChatId,
            message_id: groupMessageId,
            parse_mode: 'Markdown',
            reply_markup: generateButtons()
        });
    } catch (err) {
        console.error('Ошибка при обновлении сообщения:', err.message);
    }
}
