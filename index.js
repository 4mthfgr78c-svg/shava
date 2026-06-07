require('dotenv').config();
const { Bot, InlineKeyboard, session } = require('grammy');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { v4: uuidv4 } = require('uuid');

// ============ НАСТРОЙКИ ============
const bot = new Bot(process.env.BOT_TOKEN);
let db;

// Пароли из .env
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const COURIER_PASSWORD = process.env.COURIER_PASSWORD || 'courier123';

// Товары
const products = {
  classic: { name: 'Классическая шаурма', price: 350, emoji: '🌯' },
  signature: { name: 'Фирменная шаурма', price: 500, emoji: '🔥' },
  toppings: {
    cheese: { name: 'Сыр', price: 50 },
    jalapeno: { name: 'Халапеньо', price: 50 },
    carrot: { name: 'Морковь по-корейски', price: 50 },
    kimchi: { name: 'Кимчи', price: 50 }
  },
  cola: { name: 'Добрая кола', price: 100, emoji: '🥤' }
};

// ============ БАЗА ДАННЫХ ============
async function initDB() {
  db = await open({
    filename: './database.sqlite',
    driver: sqlite3.Database
  });
  
  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      tg_id INTEGER PRIMARY KEY,
      username TEXT,
      role TEXT DEFAULT 'user',
      balance INTEGER DEFAULT 0,
      registered_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      user_tg_id INTEGER,
      items TEXT,
      total_price INTEGER,
      status TEXT DEFAULT 'new',
      courier_tg_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      paid_at DATETIME,
      cooking_started_at DATETIME,
      ready_at DATETIME,
      assigned_at DATETIME,
      delivered_at DATETIME,
      payment_url TEXT,
      FOREIGN KEY (user_tg_id) REFERENCES users(tg_id)
    );
    
    CREATE TABLE IF NOT EXISTS courier_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      courier_tg_id INTEGER,
      date DATE DEFAULT CURRENT_DATE,
      orders_delivered INTEGER DEFAULT 0,
      total_delivery_time INTEGER DEFAULT 0,
      bonus_given INTEGER DEFAULT 0,
      FOREIGN KEY (courier_tg_id) REFERENCES users(tg_id)
    );
  `);
  
  console.log('✅ База данных готова');
}

// ============ ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ============
async function getUser(tg_id) {
  let user = await db.get('SELECT * FROM users WHERE tg_id = ?', tg_id);
  if (!user) {
    const username = `user_${tg_id}`;
    await db.run('INSERT INTO users (tg_id, username) VALUES (?, ?)', tg_id, username);
    user = await db.get('SELECT * FROM users WHERE tg_id = ?', tg_id);
  }
  return user;
}

async function setUserRole(tg_id, role) {
  await db.run('UPDATE users SET role = ? WHERE tg_id = ?', role, tg_id);
}

function getStatusEmoji(status) {
  const emojis = {
    'new': '🆕',
    'waiting_payment': '💳',
    'paid': '✅',
    'cooking': '👨‍🍳',
    'ready': '📦',
    'delivering': '🚚',
    'delivered': '🏁',
    'cancelled': '❌'
  };
  return emojis[status] || '❓';
}

// ============ ГЛАВНОЕ МЕНЮ ============
async function showMainMenu(ctx) {
  const user = await getUser(ctx.from.id);
  const role = user.role;
  let keyboard = new InlineKeyboard();
  
  if (role === 'user') {
    keyboard
      .text('🍽 Меню', 'menu')
      .row()
      .text('🚴 Стать курьером', 'become_courier')
      .row()
      .text('📦 Мой заказ', 'my_order')
      .row()
      .text('🔐 Войти как админ', 'admin_login');
  } 
  else if (role === 'courier') {
    keyboard
      .text('📋 Доступные заказы', 'available_orders')
      .row()
      .text('💰 Мой баланс', 'balance')
      .row()
      .text('⭐ Топ курьеров', 'top_couriers')
      .row()
      .text('🔓 Выйти из аккаунта', 'logout_courier');
  } 
  else if (role === 'admin') {
    keyboard
      .text('🆕 Новые заказы', 'admin_new_orders')
      .row()
      .text('💳 Ожидают оплаты', 'admin_waiting_payment')
      .row()
      .text('✅ Оплаченные', 'admin_paid_orders')
      .row()
      .text('👨‍🍳 В готовке', 'admin_cooking_orders')
      .row()
      .text('📦 Готовые', 'admin_ready_orders')
      .row()
      .text('🚚 В доставке', 'admin_delivering_orders')
      .row()
      .text('💰 Расчёт курьеров', 'admin_calc_couriers')
      .row()
      .text('🚪 Выйти из админки', 'admin_logout');
  }
  
  await ctx.reply('🥙 ДаркКитчен\nВыберите действие:', { reply_markup: keyboard });
}

// ============ МЕНЮ И КОРЗИНА ============
async function showMenu(ctx) {
  const keyboard = new InlineKeyboard()
    .text(`${products.classic.emoji} ${products.classic.name} - ${products.classic.price}₽`, 'add_classic')
    .row()
    .text(`${products.signature.emoji} ${products.signature.name} - ${products.signature.price}₽`, 'add_signature')
    .row()
    .text('➕ Топпинг (+50₽)', 'add_topping')
    .row()
    .text(`🥤 ${products.cola.name} - ${products.cola.price}₽`, 'add_cola')
    .row()
    .text('🛒 Корзина', 'view_cart')
    .text('🔙 Назад', 'back_to_menu');
  
  await ctx.reply('🍽 Меню:', { reply_markup: keyboard });
}

async function showToppings(ctx) {
  const keyboard = new InlineKeyboard()
    .text(`🧀 Сыр - 50₽`, 'add_topping_cheese')
    .row()
    .text(`🌶 Халапеньо - 50₽`, 'add_topping_jalapeno')
    .row()
    .text(`🥕 Морковь по-корейски - 50₽`, 'add_topping_carrot')
    .row()
    .text(`🥬 Кимчи - 50₽`, 'add_topping_kimchi')
    .row()
    .text('🔙 Назад', 'menu');
  
  await ctx.reply('➕ Выберите топпинг:', { reply_markup: keyboard });
}

// ============ АДМИН-ПАНЕЛЬ ============
async function showOrdersByStatus(ctx, status, title) {
  const orders = await db.all(
    'SELECT * FROM orders WHERE status = ? ORDER BY created_at ASC',
    status
  );
  
  if (orders.length === 0) {
    await ctx.reply(`📭 Нет заказов со статусом "${title}"`);
    return;
  }
  
  for (const order of orders) {
    const items = JSON.parse(order.items);
    let keyboard = new InlineKeyboard();
    
    if (status === 'new') {
      keyboard
        .text('💳 Отправить ссылку', `admin_send_link_${order.id}`)
        .row()
        .text('❌ Отказать', `admin_cancel_${order.id}`);
    }
    else if (status === 'waiting_payment') {
      keyboard
        .text('✅ Подтвердить оплату', `admin_confirm_payment_${order.id}`)
        .row()
        .text('🔄 Отправить другую ссылку', `admin_send_link_${order.id}`);
    }
    else if (status === 'paid') {
      keyboard
        .text('👨‍🍳 Начать готовку', `admin_start_cooking_${order.id}`);
    }
    else if (status === 'cooking') {
      keyboard
        .text('✅ Готов к выдаче', `admin_mark_ready_${order.id}`);
    }
    else if (status === 'ready') {
      keyboard
        .text('🚚 Назначить курьера', `admin_assign_courier_${order.id}`);
    }
    else if (status === 'delivering') {
      keyboard
        .text('✅ Подтвердить доставку', `admin_confirm_delivery_${order.id}`);
    }
    
    await ctx.reply(
      `📦 <b>Заказ #${order.id.slice(0,8)}</b>\n` +
      `👤 Клиент: ${order.user_tg_id}\n` +
      `💰 Сумма: ${order.total_price}₽\n` +
      `🍽 Состав: ${items.map(i => i.name).join(', ')}\n` +
      `📅 Создан: ${new Date(order.created_at).toLocaleString()}\n` +
      `🏷 Статус: ${getStatusEmoji(order.status)} ${order.status}`,
      { parse_mode: 'HTML', reply_markup: keyboard }
    );
  }
}

// ============ ЛОГИКА КУРЬЕРОВ ============
async function showAvailableOrders(ctx) {
  const orders = await db.all(
    `SELECT * FROM orders WHERE status = 'ready' AND courier_tg_id IS NULL 
     ORDER BY created_at ASC`
  );
  
  if (orders.length === 0) {
    await ctx.reply('📭 Нет доступных заказов');
    return;
  }
  
  for (const order of orders) {
    const items = JSON.parse(order.items);
    const keyboard = new InlineKeyboard()
      .text('🚚 Взять заказ', `take_order_${order.id}`);
    
    await ctx.reply(
      `📦 Заказ #${order.id.slice(0,8)}\n` +
      `💰 Сумма: ${order.total_price}₽\n` +
      `🍽 Состав: ${items.map(i => i.name).join(', ')}\n` +
      `⏱ Доставить за 30 минут`,
      { reply_markup: keyboard }
    );
  }
}

// ============ СЕССИИ И ОБРАБОТЧИКИ ============
bot.use(session({ initial: () => ({ 
  role: 'user',
  cart: [],
  waiting_payment_link_for: null,
  temp_password_input: false
}) }));

// Команда /start
bot.command('start', async (ctx) => {
  ctx.session.cart = [];
  ctx.session.waiting_payment_link_for = null;
  ctx.session.temp_password_input = false;
  await showMainMenu(ctx);
});

// Обработка текста (пароли и ссылки)
bot.on(':text', async (ctx) => {
  // Ввод пароля админа
  if (ctx.session.temp_password_input === 'admin') {
    if (ctx.message.text === ADMIN_PASSWORD) {
      const user = await getUser(ctx.from.id);
      await setUserRole(ctx.from.id, 'admin');
      ctx.session.temp_password_input = false;
      await ctx.reply('✅ Добро пожаловать в админ-панель!');
      await showMainMenu(ctx);
    } else {
      ctx.session.temp_password_input = false;
      await ctx.reply('❌ Неверный пароль!');
      await showMainMenu(ctx);
    }
    return;
  }
  
  // Ввод пароля курьера
  if (ctx.session.temp_password_input === 'courier') {
    if (ctx.message.text === COURIER_PASSWORD) {
      await setUserRole(ctx.from.id, 'courier');
      ctx.session.temp_password_input = false;
      await ctx.reply('✅ Поздравляем! Вы теперь курьер! 🚴');
      await showMainMenu(ctx);
    } else {
      ctx.session.temp_password_input = false;
      await ctx.reply('❌ Неверный пароль! Обратитесь к администратору.');
      await showMainMenu(ctx);
    }
    return;
  }
  
  // Ввод ссылки на оплату (админ)
  if (ctx.session.waiting_payment_link_for) {
    const orderId = ctx.session.waiting_payment_link_for;
    const paymentUrl = ctx.message.text;
    
    if (!paymentUrl.includes('yoomoney.ru') && !paymentUrl.includes('yoomoney')) {
      await ctx.reply('❌ Это не похоже на ссылку ЮMoney. Попробуйте ещё раз или /cancel');
      return;
    }
    
    const order = await db.get('SELECT * FROM orders WHERE id = ?', orderId);
    if (!order) {
      await ctx.reply('❌ Заказ не найден');
      ctx.session.waiting_payment_link_for = null;
      return;
    }
    
    await db.run('UPDATE orders SET payment_url = ?, status = "waiting_payment" WHERE id = ?', 
      paymentUrl, orderId);
    
    await bot.api.sendMessage(order.user_tg_id,
      `💳 Заказ #${orderId.slice(0,8)} на сумму ${order.total_price}₽\n\n` +
      `Оплатите по ссылке:\n${paymentUrl}\n\n` +
      `После оплаты нажмите кнопку 👇`,
      { reply_markup: new InlineKeyboard().text('✅ Оплатил', `user_paid_${orderId}`) }
    );
    
    await ctx.reply(`✅ Ссылка отправлена клиенту!\n\n${paymentUrl}`);
    ctx.session.waiting_payment_link_for = null;
    return;
  }
});

// Обработка callback'ов
bot.callbackQuery('menu', async (ctx) => {
  await ctx.answerCallbackQuery();
  await showMenu(ctx);
});

bot.callbackQuery('back_to_menu', async (ctx) => {
  await ctx.answerCallbackQuery();
  await showMainMenu(ctx);
});

bot.callbackQuery('add_topping', async (ctx) => {
  await ctx.answerCallbackQuery();
  await showToppings(ctx);
});

// Добавление в корзину
bot.callbackQuery('add_classic', async (ctx) => {
  ctx.session.cart.push({ name: products.classic.name, price: products.classic.price });
  await ctx.answerCallbackQuery(`✅ Добавлено: ${products.classic.name}`);
});

bot.callbackQuery('add_signature', async (ctx) => {
  ctx.session.cart.push({ name: products.signature.name, price: products.signature.price });
  await ctx.answerCallbackQuery(`✅ Добавлено: ${products.signature.name}`);
});

bot.callbackQuery('add_cola', async (ctx) => {
  ctx.session.cart.push({ name: products.cola.name, price: products.cola.price });
  await ctx.answerCallbackQuery(`✅ Добавлено: ${products.cola.name}`);
});

// Добавление топпингов
const toppingsMap = {
  cheese: 'Сыр', jalapeno: 'Халапеньо', carrot: 'Морковь по-корейски', kimchi: 'Кимчи'
};

for (const [key, name] of Object.entries(toppingsMap)) {
  bot.callbackQuery(`add_topping_${key}`, async (ctx) => {
    ctx.session.cart.push({ name: name, price: 50 });
    await ctx.answerCallbackQuery(`✅ Добавлено: ${name} (+50₽)`);
  });
}

// Просмотр корзины
bot.callbackQuery('view_cart', async (ctx) => {
  if (ctx.session.cart.length === 0) {
    await ctx.reply('🛒 Корзина пуста');
    return;
  }
  
  const total = ctx.session.cart.reduce((sum, item) => sum + item.price, 0);
  const itemsList = ctx.session.cart.map((item, i) => `${i+1}. ${item.name} - ${item.price}₽`).join('\n');
  
  const keyboard = new InlineKeyboard()
    .text('✅ Оформить заказ', 'checkout')
    .row()
    .text('🗑 Очистить корзину', 'clear_cart')
    .text('🔙 Назад', 'menu');
  
  await ctx.reply(`🛒 Ваша корзина:\n${itemsList}\n\n💰 Итого: ${total}₽`, { reply_markup: keyboard });
});

bot.callbackQuery('clear_cart', async (ctx) => {
  ctx.session.cart = [];
  await ctx.answerCallbackQuery('Корзина очищена');
  await showMenu(ctx);
});

bot.callbackQuery('checkout', async (ctx) => {
  if (ctx.session.cart.length === 0) {
    await ctx.reply('Корзина пуста');
    return;
  }
  
  const orderId = uuidv4();
  const total = ctx.session.cart.reduce((sum, item) => sum + item.price, 0);
  
  await db.run(
    'INSERT INTO orders (id, user_tg_id, items, total_price, status) VALUES (?, ?, ?, ?, ?)',
    orderId, ctx.from.id, JSON.stringify(ctx.session.cart), total, 'new'
  );
  
  // Уведомляем админов
  const admins = await db.all('SELECT tg_id FROM users WHERE role = "admin"');
  for (const admin of admins) {
    await bot.api.sendMessage(admin.tg_id, 
      `🆕 <b>НОВЫЙ ЗАКАЗ #${orderId.slice(0,8)}</b>\n` +
      `👤 Клиент: @${ctx.from.username || ctx.from.id}\n` +
      `💰 Сумма: ${total}₽\n` +
      `🍽 Состав: ${ctx.session.cart.map(i => i.name).join(', ')}`,
      { parse_mode: 'HTML' }
    );
  }
  
  ctx.session.cart = [];
  await ctx.reply(`✅ Заказ #${orderId.slice(0,8)} создан!\nСумма: ${total}₽\nОжидайте ссылку на оплату от администратора.`);
});

// Стать курьером
bot.callbackQuery('become_courier', async (ctx) => {
  const user = await getUser(ctx.from.id);
  if (user.role === 'courier') {
    await ctx.reply('Вы уже курьер!');
    return;
  }
  
  ctx.session.temp_password_input = 'courier';
  await ctx.reply('🔑 Введите пароль для регистрации курьера:', {
    reply_markup: new InlineKeyboard().text('❌ Отмена', 'cancel_courier_reg')
  });
});

bot.callbackQuery('cancel_courier_reg', async (ctx) => {
  ctx.session.temp_password_input = false;
  await ctx.reply('Регистрация отменена');
  await showMainMenu(ctx);
});

// Вход в админку
bot.callbackQuery('admin_login', async (ctx) => {
  ctx.session.temp_password_input = 'admin';
  await ctx.reply('🔐 Введите пароль администратора:', {
    reply_markup: new InlineKeyboard().text('❌ Отмена', 'cancel_admin_login')
  });
});

bot.callbackQuery('cancel_admin_login', async (ctx) => {
  ctx.session.temp_password_input = false;
  await ctx.reply('Вход отменён');
  await showMainMenu(ctx);
});

bot.callbackQuery('admin_logout', async (ctx) => {
  await setUserRole(ctx.from.id, 'user');
  ctx.session.temp_password_input = false;
  await ctx.reply('Вы вышли из админки');
  await showMainMenu(ctx);
});

// Админ: просмотр заказов по статусам
bot.callbackQuery('admin_new_orders', async (ctx) => {
  await ctx.answerCallbackQuery();
  await showOrdersByStatus(ctx, 'new', 'Новые');
});

bot.callbackQuery('admin_waiting_payment', async (ctx) => {
  await ctx.answerCallbackQuery();
  await showOrdersByStatus(ctx, 'waiting_payment', 'Ожидают оплаты');
});

bot.callbackQuery('admin_paid_orders', async (ctx) => {
  await ctx.answerCallbackQuery();
  await showOrdersByStatus(ctx, 'paid', 'Оплаченные');
});

bot.callbackQuery('admin_cooking_orders', async (ctx) => {
  await ctx.answerCallbackQuery();
  await showOrdersByStatus(ctx, 'cooking', 'В готовке');
});

bot.callbackQuery('admin_ready_orders', async (ctx) => {
  await ctx.answerCallbackQuery();
  await showOrdersByStatus(ctx, 'ready', 'Готовые');
});

bot.callbackQuery('admin_delivering_orders', async (ctx) => {
  await ctx.answerCallbackQuery();
  await showOrdersByStatus(ctx, 'delivering', 'В доставке');
});

// Админ: отправить ссылку
bot.callbackQuery(/admin_send_link_(.+)/, async (ctx) => {
  const orderId = ctx.match[1];
  ctx.session.waiting_payment_link_for = orderId;
  await ctx.reply('📎 Вставьте ссылку на оплату (с ЮMoney):\n\nПример: https://yoomoney.ru/quickpay/...\n\nИли /cancel');
});

// Админ: подтвердить оплату
bot.callbackQuery(/admin_confirm_payment_(.+)/, async (ctx) => {
  const orderId = ctx.match[1];
  await db.run('UPDATE orders SET status = "paid", paid_at = CURRENT_TIMESTAMP WHERE id = ?', orderId);
  await ctx.reply('✅ Оплата подтверждена');
  await showOrdersByStatus(ctx, 'waiting_payment', 'Ожидают оплаты');
});

// Админ: начать готовку
bot.callbackQuery(/admin_start_cooking_(.+)/, async (ctx) => {
  const orderId = ctx.match[1];
  await db.run('UPDATE orders SET status = "cooking", cooking_started_at = CURRENT_TIMESTAMP WHERE id = ?', orderId);
  await ctx.reply('👨‍🍳 Готовка начата');
  await showOrdersByStatus(ctx, 'paid', 'Оплаченные');
});

// Админ: готов к выдаче
bot.callbackQuery(/admin_mark_ready_(.+)/, async (ctx) => {
  const orderId = ctx.match[1];
  await db.run('UPDATE orders SET status = "ready", ready_at = CURRENT_TIMESTAMP WHERE id = ?', orderId);
  await ctx.reply('✅ Заказ готов к выдаче');
  await showOrdersByStatus(ctx, 'cooking', 'В готовке');
});

// Админ: назначить курьера
bot.callbackQuery(/admin_assign_courier_(.+)/, async (ctx) => {
  const orderId = ctx.match[1];
  const couriers = await db.all('SELECT tg_id, username FROM users WHERE role = "courier"');
  
  if (couriers.length === 0) {
    await ctx.reply('❌ Нет зарегистрированных курьеров');
    return;
  }
  
  let keyboard = new InlineKeyboard();
  for (const courier of couriers) {
    keyboard.text(`🚴 ${courier.username || courier.tg_id}`, `assign_courier_${orderId}_${courier.tg_id}`).row();
  }
  keyboard.text('🔙 Назад', 'admin_ready_orders');
  
  await ctx.reply('Выберите курьера:', { reply_markup: keyboard });
});

bot.callbackQuery(/assign_courier_(.+)_(.+)/, async (ctx) => {
  const orderId = ctx.match[1];
  const courierId = parseInt(ctx.match[2]);
  
  await db.run('UPDATE orders SET status = "delivering", courier_tg_id = ?, assigned_at = CURRENT_TIMESTAMP WHERE id = ?', 
    courierId, orderId);
  
  const order = await db.get('SELECT * FROM orders WHERE id = ?', orderId);
  
  // Уведомляем курьера
  await bot.api.sendMessage(courierId,
    `🚚 Вам назначен заказ #${orderId.slice(0,8)}!\n` +
    `💰 Сумма: ${order.total_price}₽\n` +
    `👤 Клиент: ${order.user_tg_id}\n` +
    `⏱ Доставьте за 30 минут`,
    { reply_markup: new InlineKeyboard().text('✅ Доставил', `courier_delivered_${orderId}`) }
  );
  
  await ctx.reply(`✅ Курьер назначен`);
});

// Курьер: доставил
bot.callbackQuery(/courier_delivered_(.+)/, async (ctx) => {
  const orderId = ctx.match[1];
  const order = await db.get('SELECT * FROM orders WHERE id = ?', orderId);
  
  // Проверяем время доставки
  const assignedAt = new Date(order.assigned_at);
  const deliveredAt = new Date();
  const minutesDiff = (deliveredAt - assignedAt) / 1000 / 60;
  
  let deliveryFee = 100; // стандартная оплата 100₽
  let bonusMessage = '';
  
  if (minutesDiff > 30) {
    deliveryFee = 0;
    bonusMessage = '\n\n⚠️ Превышен лимит времени (30 мин)! Оплата не начислена.';
  }
  
  // Начисляем оплату курьеру
  const courier = await getUser(order.courier_tg_id);
  await db.run('UPDATE users SET balance = balance + ? WHERE tg_id = ?', deliveryFee, order.courier_tg_id);
  
  // Обновляем статистику
  await db.run(
    `INSERT INTO courier_stats (courier_tg_id, orders_delivered, total_delivery_time) 
     VALUES (?, 1, ?) 
     ON CONFLICT(date, courier_tg_id) DO UPDATE SET 
     orders_delivered = orders_delivered + 1,
     total_delivery_time = total_delivery_time + ?`,
    order.courier_tg_id, minutesDiff, minutesDiff
  );
  
  await db.run('UPDATE orders SET status = "delivered", delivered_at = CURRENT_TIMESTAMP WHERE id = ?', orderId);
  
  await ctx.reply(`✅ Доставка завершена!${bonusMessage}\n💰 Начислено: ${deliveryFee}₽`);
  
  // Уведомляем админов
  const admins = await db.all('SELECT tg_id FROM users WHERE role = "admin"');
  for (const admin of admins) {
    await bot.api.sendMessage(admin.tg_id, 
      `🏁 Заказ #${orderId.slice(0,8)} доставлен\n⏱ Время: ${Math.round(minutesDiff)} мин\n💰 Курьер получил: ${deliveryFee}₽`
    );
  }
});

// Курьер: взять заказ
bot.callbackQuery(/take_order_(.+)/, async (ctx) => {
  const orderId = ctx.match[1];
  const order = await db.get('SELECT * FROM orders WHERE id = ? AND status = "ready" AND courier_tg_id IS NULL', orderId);
  
  if (!order) {
    await ctx.reply('❌ Заказ уже кто-то взял');
    return;
  }
  
  await db.run('UPDATE orders SET status = "delivering", courier_tg_id = ?, assigned_at = CURRENT_TIMESTAMP WHERE id = ?',
    ctx.from.id, orderId);
  
  await ctx.reply(`✅ Заказ #${orderId.slice(0,8)} взят!\n⏱ Доставьте за 30 минут`,
    { reply_markup: new InlineKeyboard().text('✅ Доставил', `courier_delivered_${orderId}`) }
  );
  
  // Уведомляем админа
  const admins = await db.all('SELECT tg_id FROM users WHERE role = "admin"');
  for (const admin of admins) {
    await bot.api.sendMessage(admin.tg_id, `🚚 Курьер взял заказ #${orderId.slice(0,8)}`);
  }
});

// Курьер: баланс
bot.callbackQuery('balance', async (ctx) => {
  const user = await getUser(ctx.from.id);
  await ctx.reply(`💰 Ваш баланс: ${user.balance}₽\nВыплаты производятся администратором в конце дня`);
});

// Курьер: топ курьеров
bot.callbackQuery('top_couriers', async (ctx) => {
  const top = await db.all(
    `SELECT u.username, cs.orders_delivered, cs.total_delivery_time 
     FROM courier_stats cs 
     JOIN users u ON u.tg_id = cs.courier_tg_id 
     WHERE cs.date = CURRENT_DATE 
     ORDER BY cs.orders_delivered DESC 
     LIMIT 5`
  );
  
  if (top.length === 0) {
    await ctx.reply('📊 Сегодня ещё нет доставок');
    return;
  }
  
  let message = '🏆 Топ курьеров сегодня:\n\n';
  for (let i = 0; i < top.length; i++) {
    const avgTime = top[i].orders_delivered > 0 ? Math.round(top[i].total_delivery_time / top[i].orders_delivered) : 0;
    message += `${i+1}. ${top[i].username || 'Курьер'} — ${top[i].orders_delivered} доставок, среднее ${avgTime} мин\n`;
  }
  
  await ctx.reply(message);
});

// Курьер: выйти
bot.callbackQuery('logout_courier', async (ctx) => {
  await setUserRole(ctx.from.id, 'user');
  await ctx.reply('Вы вышли из аккаунта курьера');
  await showMainMenu(ctx);
});

// Клиент: мой заказ
bot.callbackQuery('my_order', async (ctx) => {
  const order = await db.get(
    'SELECT * FROM orders WHERE user_tg_id = ? AND status NOT IN ("delivered", "cancelled") ORDER BY created_at DESC LIMIT 1',
    ctx.from.id
  );
  
  if (!order) {
    await ctx.reply('📭 У вас нет активных заказов');
    return;
  }
  
  const items = JSON.parse(order.items);
  await ctx.reply(
    `📦 Ваш заказ #${order.id.slice(0,8)}\n` +
    `Статус: ${getStatusEmoji(order.status)} ${order.status}\n` +
    `💰 Сумма: ${order.total_price}₽\n` +
    `🍽 Состав: ${items.map(i => i.name).join(', ')}\n` +
    (order.payment_url ? `\n🔗 Ссылка на оплату: ${order.payment_url}` : '')
  );
});

// Клиент: оплатил
bot.callbackQuery(/user_paid_(.+)/, async (ctx) => {
  const orderId = ctx.match[1];
  await db.run('UPDATE orders SET status = "paid", paid_at = CURRENT_TIMESTAMP WHERE id = ?', orderId);
  
  await ctx.reply('✅ Спасибо! Администратор получил уведомление.');
  
  const admins = await db.all('SELECT tg_id FROM users WHERE role = "admin"');
  for (const admin of admins) {
    await bot.api.sendMessage(admin.tg_id, 
      `💰 Клиент подтвердил оплату заказа #${orderId.slice(0,8)}`,
      { reply_markup: new InlineKeyboard().text('👨‍🍳 Начать готовку', `admin_start_cooking_${orderId}`) }
    );
  }
});

// Курьер: доступные заказы
bot.callbackQuery('available_orders', async (ctx) => {
  await ctx.answerCallbackQuery();
  await showAvailableOrders(ctx);
});

// Админ: расчёт курьеров
bot.callbackQuery('admin_calc_couriers', async (ctx) => {
  const couriers = await db.all(
    'SELECT tg_id, username, balance FROM users WHERE role = "courier" AND balance > 0'
  );
  
  if (couriers.length === 0) {
    await ctx.reply('💰 Нет выплат для курьеров');
    return;
  }
  
  let message = '💰 <b>Расчёт курьеров за сегодня:</b>\n\n';
  for (const courier of couriers) {
    message += `👤 ${courier.username || courier.tg_id}: ${courier.balance}₽\n`;
  }
  message += '\n<i>Скопируйте суммы и переведите курьерам вручную</i>';
  
  const keyboard = new InlineKeyboard().text('✅ Обнулить балансы', 'reset_courier_balances');
  
  await ctx.reply(message, { parse_mode: 'HTML', reply_markup: keyboard });
});

bot.callbackQuery('reset_courier_balances', async (ctx) => {
  await db.run('UPDATE users SET balance = 0 WHERE role = "courier"');
  await ctx.reply('✅ Балансы курьеров обнулены');
});

// Отмена заказа админом
bot.callbackQuery(/admin_cancel_(.+)/, async (ctx) => {
  const orderId = ctx.match[1];
  await db.run('UPDATE orders SET status = "cancelled" WHERE id = ?', orderId);
  await ctx.reply(`❌ Заказ #${orderId.slice(0,8)} отменён`);
  await showOrdersByStatus(ctx, 'new', 'Новые');
});

// ============ ЗАПУСК ============
async function main() {
  await initDB();
  bot.start();
  console.log('✅ Бот запущен!');
  
  // Устанавливаем команды для меню
  await bot.api.setMyCommands([
    { command: 'start', description: '🏠 Главное меню' },
    { command: 'cancel', description: '❌ Отмена' }
  ]);
}

main().catch(console.error);