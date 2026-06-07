cat > bot.py << 'EOF'
import asyncio
import json
import os
from aiogram import Bot, Dispatcher, types, F
from aiogram.filters import Command
from aiogram.types import InlineKeyboardMarkup, InlineKeyboardButton, ReplyKeyboardMarkup, KeyboardButton
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from dotenv import load_dotenv

load_dotenv()

BOT_TOKEN = os.getenv('BOT_TOKEN')
ADMIN_PASSWORD = os.getenv('ADMIN_PASSWORD', 'admin123')
COURIER_PASSWORD = os.getenv('COURIER_PASSWORD', 'courier123')

bot = Bot(token=BOT_TOKEN)
dp = Dispatcher()

PICKUP_ADDRESS = "г. Долинск, ул. Лермонтова 17/2"

users = {}
orders = {}
temp_orders = {}
user_carts = {}
temp_links = {}
last_order_id = 1

class OrderStates(StatesGroup):
    waiting_address = State()
    waiting_phone = State()

class AdminStates(StatesGroup):
    waiting_payment_link = State()
    waiting_admin_password = State()

class CourierStates(StatesGroup):
    waiting_courier_password = State()

def get_user(tg_id):
    if tg_id not in users:
        users[tg_id] = {"role": "user", "balance": 0}
    return users[tg_id]

def set_role(tg_id, role):
    users[tg_id]["role"] = role

def generate_order_id():
    global last_order_id
    oid = last_order_id
    last_order_id += 1
    return str(oid)

def get_admins():
    return [uid for uid, data in users.items() if data["role"] == "admin"]

async def show_main_menu(message: types.Message):
    user = get_user(message.from_user.id)
    role = user["role"]
    kb = InlineKeyboardMarkup(inline_keyboard=[])
    if role == "user":
        kb.inline_keyboard = [
            [InlineKeyboardButton(text="🍽 Меню", callback_data="menu")],
            [InlineKeyboardButton(text="🚴 Стать курьером", callback_data="become_courier")],
            [InlineKeyboardButton(text="📦 Мой заказ", callback_data="my_order")],
            [InlineKeyboardButton(text="🔐 Войти как админ", callback_data="admin_login")]
        ]
    elif role == "courier":
        kb.inline_keyboard = [
            [InlineKeyboardButton(text="📋 Доступные заказы", callback_data="available_orders")],
            [InlineKeyboardButton(text="💰 Мой баланс", callback_data="balance")],
            [InlineKeyboardButton(text="🔓 Выйти", callback_data="logout_courier")]
        ]
    elif role == "admin":
        kb.inline_keyboard = [
            [InlineKeyboardButton(text="📋 ВСЕ ЗАКАЗЫ", callback_data="admin_all_orders")],
            [InlineKeyboardButton(text="🔓 Выйти", callback_data="admin_logout")]
        ]
    await message.answer("🥙 ДаркКитчен\nВыберите действие:", reply_markup=kb)

@dp.callback_query(F.data == "menu")
async def cmd_menu(callback: types.CallbackQuery):
    kb = InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text="🌯 Классическая шаурма - 350₽", callback_data="add_classic")],
        [InlineKeyboardButton(text="🔥 Фирменная шаурма - 500₽", callback_data="add_signature")],
        [InlineKeyboardButton(text="🥤 Добрая кола - 100₽", callback_data="add_cola")],
        [InlineKeyboardButton(text="🛒 Корзина", callback_data="view_cart"), InlineKeyboardButton(text="🔙 Назад", callback_data="back_to_menu")]
    ])
    await callback.message.edit_text("🍽 Меню:", reply_markup=kb)
    await callback.answer()

@dp.callback_query(F.data.startswith("add_"))
async def add_to_cart(callback: types.CallbackQuery):
    uid = callback.from_user.id
    if uid not in user_carts:
        user_carts[uid] = []
    if callback.data == "add_classic":
        user_carts[uid].append({"name": "Классическая шаурма", "price": 350})
    elif callback.data == "add_signature":
        user_carts[uid].append({"name": "Фирменная шаурма", "price": 500})
    elif callback.data == "add_cola":
        user_carts[uid].append({"name": "Добрая кола", "price": 100})
    await callback.answer("✅ Добавлено!")

@dp.callback_query(F.data == "view_cart")
async def view_cart(callback: types.CallbackQuery):
    uid = callback.from_user.id
    cart = user_carts.get(uid, [])
    if not cart:
        await callback.message.edit_text("🛒 Корзина пуста")
        await callback.answer()
        return
    total = sum(i["price"] for i in cart)
    items = "\n".join([f"{i+1}. {item['name']} - {item['price']}₽" for i, item in enumerate(cart)])
    kb = InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text="✅ Оформить заказ", callback_data="checkout")],
        [InlineKeyboardButton(text="🗑 Очистить", callback_data="clear_cart"), InlineKeyboardButton(text="🔙 Назад", callback_data="menu")]
    ])
    await callback.message.edit_text(f"🛒 Корзина:\n{items}\n\n💰 Итого: {total}₽", reply_markup=kb)
    await callback.answer()

@dp.callback_query(F.data == "clear_cart")
async def clear_cart(callback: types.CallbackQuery):
    user_carts[callback.from_user.id] = []
    await callback.answer("Корзина очищена")
    await cmd_menu(callback)

@dp.callback_query(F.data == "checkout")
async def checkout(callback: types.CallbackQuery, state: FSMContext):
    uid = callback.from_user.id
    cart = user_carts.get(uid, [])
    if not cart:
        await callback.answer("Корзина пуста")
        return
    temp_orders[uid] = {"cart": cart.copy()}
    kb = ReplyKeyboardMarkup(keyboard=[[KeyboardButton(text="📍 Отправить местоположение", request_location=True)]], resize_keyboard=True)
    await callback.message.answer("📍 Укажите адрес доставки:", reply_markup=kb)
    await state.set_state(OrderStates.waiting_address)
    await callback.answer()

@dp.message(OrderStates.waiting_address)
async def get_address(msg: types.Message, state: FSMContext):
    uid = msg.from_user.id
    if uid not in temp_orders:
        await msg.answer("❌ Ошибка. Начните заново.")
        await state.clear()
        await show_main_menu(msg)
        return
    addr = f"Геолокация: {msg.location.latitude}, {msg.location.longitude}" if msg.location else msg.text
    temp_orders[uid]["address"] = addr
    kb = ReplyKeyboardMarkup(keyboard=[[KeyboardButton(text="📱 Отправить номер", request_contact=True)]], resize_keyboard=True)
    await msg.answer("📞 Укажите номер телефона:", reply_markup=kb)
    await state.set_state(OrderStates.waiting_phone)

@dp.message(OrderStates.waiting_phone)
async def get_phone(msg: types.Message, state: FSMContext):
    uid = msg.from_user.id
    if uid not in temp_orders:
        await msg.answer("❌ Ошибка. Начните заново.")
        await state.clear()
        await show_main_menu(msg)
        return
    phone = msg.contact.phone_number if msg.contact else msg.text
    cart = temp_orders[uid]["cart"]
    address = temp_orders[uid]["address"]
    oid = generate_order_id()
    total = sum(i["price"] for i in cart)
    orders[oid] = {
        "user_id": uid,
        "items": cart.copy(),
        "total": total,
        "address": address,
        "phone": phone,
        "status": "new",
        "courier_id": None
    }
    user_carts[uid] = []
    del temp_orders[uid]
    items_text = ", ".join([i["name"] for i in cart])
    username = msg.from_user.username or str(msg.from_user.id)
    for admin_id in get_admins():
        await bot.send_message(admin_id,
            f"🆕 <b>НОВЫЙ ЗАКАЗ #{oid}</b>\n👤 @{username}\n💰 {total}₽\n🍽 {items_text}\n📍 {address}\n📞 {phone}",
            parse_mode="HTML",
            reply_markup=InlineKeyboardMarkup(inline_keyboard=[
                [InlineKeyboardButton(text="💳 ОТПРАВИТЬ ССЫЛКУ", callback_data=f"send_link_{oid}")],
                [InlineKeyboardButton(text="❌ ОТКАЗАТЬ", callback_data=f"cancel_{oid}")]
            ]))
    await msg.answer(f"✅ <b>Заказ #{oid} создан!</b>\n💰 {total}₽\n📍 {address}\n📞 {phone}\n\nОжидайте ссылку на оплату.", parse_mode="HTML", reply_markup=types.ReplyKeyboardRemove())
    await state.clear()

@dp.callback_query(F.data.startswith("send_link_"))
async def send_link_prompt(callback: types.CallbackQuery, state: FSMContext):
    oid = callback.data.replace("send_link_", "")
    temp_links[callback.from_user.id] = oid
    await callback.message.answer(f"📎 Введите ссылку на оплату для заказа #{oid}:")
    await callback.answer()

@dp.message()
async def handle_payment_link(msg: types.Message):
    uid = msg.from_user.id
    if uid not in temp_links:
        return
    oid = temp_links[uid]
    url = msg.text
    if oid not in orders:
        await msg.answer("❌ Заказ не найден")
        del temp_links[uid]
        return
    order = orders[oid]
    items_text = ", ".join([i["name"] for i in order["items"]])
    await bot.send_message(order["user_id"],
        f"💳 <b>Ссылка на оплату #{oid}</b>\n💰 {order['total']}₽\n🍽 {items_text}\n\n🔗 <a href='{url}'>Оплатить</a>\n\n✅ После оплаты нажмите кнопку:",
        parse_mode="HTML",
        reply_markup=InlineKeyboardMarkup(inline_keyboard=[
            [InlineKeyboardButton(text="✅ Я ОПЛАТИЛ", callback_data=f"paid_{oid}")]
        ]))
    orders[oid]["status"] = "waiting_payment"
    await msg.answer(f"✅ Ссылка отправлена клиенту!")
    del temp_links[uid]

@dp.callback_query(F.data.startswith("paid_"))
async def user_paid(callback: types.CallbackQuery):
    oid = callback.data.replace("paid_", "")
    if oid not in orders:
        await callback.answer("Заказ не найден")
        return
    orders[oid]["status"] = "paid"
    await callback.message.answer("✅ Спасибо! Оплата подтверждена.")
    for admin_id in get_admins():
        await bot.send_message(admin_id, f"💰 Клиент оплатил заказ #{oid}", reply_markup=InlineKeyboardMarkup(inline_keyboard=[
            [InlineKeyboardButton(text="👨‍🍳 НАЧАТЬ ГОТОВКУ", callback_data=f"cooking_{oid}")]
        ]))
    await callback.answer()

@dp.callback_query(F.data == "admin_all_orders")
async def admin_all_orders(callback: types.CallbackQuery):
    await callback.answer()
    if not orders:
        await callback.message.answer("📭 Нет заказов")
        return
    status_names = {"new": "🆕 Новый", "waiting_payment": "💳 Ждёт оплату", "paid": "✅ Оплачен", "cooking": "👨‍🍳 Готовится", "ready": "📦 Готов", "delivering": "🚚 В доставке", "delivered": "🏁 Доставлен"}
    for oid, order in orders.items():
        items_text = ", ".join([i["name"] for i in order["items"]])
        kb = InlineKeyboardMarkup(inline_keyboard=[])
        if order["status"] == "new":
            kb.inline_keyboard = [[InlineKeyboardButton(text="💳 Ссылку", callback_data=f"send_link_{oid}")]]
        elif order["status"] == "waiting_payment":
            kb.inline_keyboard = [[InlineKeyboardButton(text="✅ Оплатил", callback_data=f"admin_confirm_{oid}")]]
        elif order["status"] == "paid":
            kb.inline_keyboard = [[InlineKeyboardButton(text="👨‍🍳 Готовить", callback_data=f"cooking_{oid}")]]
        elif order["status"] == "cooking":
            kb.inline_keyboard = [[InlineKeyboardButton(text="✅ Готово", callback_data=f"ready_{oid}")]]
        elif order["status"] == "ready":
            kb.inline_keyboard = [[InlineKeyboardButton(text="🚚 Курьеру", callback_data=f"assign_{oid}")]]
        elif order["status"] == "delivering":
            kb.inline_keyboard = [[InlineKeyboardButton(text="✅ Доставлен", callback_data=f"deliver_{oid}")]]
        await callback.message.answer(
            f"<b>📦 ЗАКАЗ #{oid}</b>\n🏷 {status_names.get(order['status'], order['status'])}\n👤 {order['user_id']}\n💰 {order['total']}₽\n🍽 {items_text}\n📍 {order['address']}\n📞 {order['phone']}",
            parse_mode="HTML",
            reply_markup=kb if kb.inline_keyboard else None
        )

@dp.callback_query(F.data.startswith("admin_confirm_"))
async def admin_confirm_payment(callback: types.CallbackQuery):
    oid = callback.data.replace("admin_confirm_", "")
    if oid in orders:
        orders[oid]["status"] = "paid"
        await callback.message.answer("✅ Оплата подтверждена")
    await callback.answer()

@dp.callback_query(F.data.startswith("cooking_"))
async def start_cooking(callback: types.CallbackQuery):
    oid = callback.data.replace("cooking_", "")
    if oid in orders:
        orders[oid]["status"] = "cooking"
        await callback.message.answer("👨‍🍳 Готовка начата")
    await callback.answer()

@dp.callback_query(F.data.startswith("ready_"))
async def mark_ready(callback: types.CallbackQuery):
    oid = callback.data.replace("ready_", "")
    if oid in orders:
        orders[oid]["status"] = "ready"
        await callback.message.answer("✅ Заказ готов к выдаче")
        for uid, data in users.items():
            if data["role"] == "courier":
                await bot.send_message(uid, f"📦 Новый готовый заказ #{oid}!", reply_markup=InlineKeyboardMarkup(inline_keyboard=[
                    [InlineKeyboardButton(text="🚚 ВЗЯТЬ ЗАКАЗ", callback_data=f"take_{oid}")]
                ]))
    await callback.answer()

@dp.callback_query(F.data.startswith("assign_"))
async def assign_courier_prompt(callback: types.CallbackQuery):
    oid = callback.data.replace("assign_", "")
    couriers = [(uid, data) for uid, data in users.items() if data["role"] == "courier"]
    if not couriers:
        await callback.message.answer("❌ Нет курьеров")
        await callback.answer()
        return
    kb = InlineKeyboardMarkup(inline_keyboard=[])
    for uid, data in couriers:
        kb.inline_keyboard.append([InlineKeyboardButton(text=f"🚴 {uid}", callback_data=f"assign_courier_{oid}_{uid}")])
    await callback.message.answer("Выберите курьера:", reply_markup=kb)
    await callback.answer()

@dp.callback_query(F.data.startswith("assign_courier_"))
async def assign_courier(callback: types.CallbackQuery):
    parts = callback.data.split("_")
    oid = parts[2]
    courier_id = int(parts[3])
    if oid in orders:
        orders[oid]["status"] = "delivering"
        orders[oid]["courier_id"] = courier_id
        order = orders[oid]
        await bot.send_message(courier_id,
            f"🚚 <b>Заказ #{oid}</b>\n💰 {order['total']}₽\n🍽 {', '.join([i['name'] for i in order['items']])}\n📍 Забрать: {PICKUP_ADDRESS}\n📍 Доставить: {order['address']}\n📞 {order['phone']}\n⏱ 30 минут",
            parse_mode="HTML",
            reply_markup=InlineKeyboardMarkup(inline_keyboard=[
                [InlineKeyboardButton(text="✅ ДОСТАВИЛ", callback_data=f"delivered_{oid}")]
            ]))
        await callback.message.answer(f"✅ Курьер назначен")
    await callback.answer()

@dp.callback_query(F.data.startswith("deliver_"))
async def admin_confirm_delivery(callback: types.CallbackQuery):
    oid = callback.data.replace("deliver_", "")
    if oid in orders:
        orders[oid]["status"] = "delivered"
        await callback.message.answer("✅ Доставлено")
    await callback.answer()

@dp.callback_query(F.data.startswith("take_"))
async def take_order(callback: types.CallbackQuery):
    oid = callback.data.replace("take_", "")
    if oid in orders and orders[oid]["status"] == "ready":
        orders[oid]["status"] = "delivering"
        orders[oid]["courier_id"] = callback.from_user.id
        await callback.message.answer(f"✅ Заказ #{oid} взят!\n⏱ 30 минут", reply_markup=InlineKeyboardMarkup(inline_keyboard=[
            [InlineKeyboardButton(text="✅ ДОСТАВИЛ", callback_data=f"delivered_{oid}")]
        ]))
    else:
        await callback.message.answer("❌ Заказ уже кто-то взял")
    await callback.answer()

@dp.callback_query(F.data.startswith("delivered_"))
async def courier_delivered(callback: types.CallbackQuery):
    oid = callback.data.replace("delivered_", "")
    if oid in orders:
        orders[oid]["status"] = "delivered"
        users[callback.from_user.id]["balance"] += 100
        await callback.message.answer(f"✅ Доставка завершена! +100₽")
        for admin_id in get_admins():
            await bot.send_message(admin_id, f"🏁 Курьер доставил заказ #{oid}")
    await callback.answer()

@dp.message(Command("start"))
async def cmd_start(msg: types.Message):
    user_carts[msg.from_user.id] = []
    await show_main_menu(msg)

@dp.callback_query(F.data == "back_to_menu")
async def back_to_menu(callback: types.CallbackQuery):
    await show_main_menu(callback.message)
    await callback.answer()

@dp.callback_query(F.data == "become_courier")
async def become_courier(callback: types.CallbackQuery, state: FSMContext):
    await state.set_state(CourierStates.waiting_courier_password)
    await callback.message.answer("🔑 Введите пароль курьера:")
    await callback.answer()

@dp.message(CourierStates.waiting_courier_password)
async def process_courier_password(msg: types.Message, state: FSMContext):
    if msg.text == COURIER_PASSWORD:
        set_role(msg.from_user.id, "courier")
        await msg.answer("✅ Вы теперь курьер! 🚴")
        await show_main_menu(msg)
    else:
        await msg.answer("❌ Неверный пароль!")
    await state.clear()

@dp.callback_query(F.data == "admin_login")
async def admin_login(callback: types.CallbackQuery, state: FSMContext):
    await state.set_state(AdminStates.waiting_admin_password)
    await callback.message.answer("🔐 Введите пароль администратора:")
    await callback.answer()

@dp.message(AdminStates.waiting_admin_password)
async def process_admin_password(msg: types.Message, state: FSMContext):
    if msg.text == ADMIN_PASSWORD:
        set_role(msg.from_user.id, "admin")
        await msg.answer("✅ Добро пожаловать в админ-панель!")
        await show_main_menu(msg)
    else:
        await msg.answer("❌ Неверный пароль!")
    await state.clear()

@dp.callback_query(F.data == "logout_courier")
async def logout_courier(callback: types.CallbackQuery):
    set_role(callback.from_user.id, "user")
    await callback.message.answer("Вы вышли из аккаунта курьера")
    await show_main_menu(callback.message)
    await callback.answer()

@dp.callback_query(F.data == "admin_logout")
async def admin_logout(callback: types.CallbackQuery):
    set_role(callback.from_user.id, "user")
    await callback.message.answer("Вы вышли из админки")
    await show_main_menu(callback.message)
    await callback.answer()

@dp.callback_query(F.data == "balance")
async def show_balance(callback: types.CallbackQuery):
    user = get_user(callback.from_user.id)
    await callback.message.answer(f"💰 Ваш баланс: {user['balance']}₽")
    await callback.answer()

@dp.callback_query(F.data == "my_order")
async def my_order(callback: types.CallbackQuery):
    for oid, order in orders.items():
        if order["user_id"] == callback.from_user.id and order["status"] not in ["delivered", "cancelled"]:
            status_names = {"new": "🆕 Новый", "waiting_payment": "💳 Ожидает оплаты", "paid": "✅ Оплачен", "cooking": "👨‍🍳 Готовится", "ready": "📦 Готов", "delivering": "🚚 В доставке"}
            items_text = ", ".join([i["name"] for i in order["items"]])
            await callback.message.answer(f"<b>📦 ЗАКАЗ #{oid}</b>\n🏷 {status_names.get(order['status'], order['status'])}\n💰 {order['total']}₽\n🍽 {items_text}\n📍 {order['address']}", parse_mode="HTML")
            await callback.answer()
            return
    await callback.message.answer("📭 У вас нет активных заказов")
    await callback.answer()

@dp.callback_query(F.data == "available_orders")
async def available_orders(callback: types.CallbackQuery):
    ready = [(oid, order) for oid, order in orders.items() if order["status"] == "ready" and order.get("courier_id") is None]
    if not ready:
        await callback.message.answer("📭 Нет доступных заказов")
        await callback.answer()
        return
    for oid, order in ready:
        items_text = ", ".join([i["name"] for i in order["items"]])
        await callback.message.answer(f"📦 <b>Заказ #{oid}</b>\n💰 {order['total']}₽\n🍽 {items_text}\n📍 Доставить: {order['address']}\n📍 Забрать: {PICKUP_ADDRESS}", parse_mode="HTML", reply_markup=InlineKeyboardMarkup(inline_keyboard=[
            [InlineKeyboardButton(text="🚚 ВЗЯТЬ ЗАКАЗ", callback_data=f"take_{oid}")]
        ]))
    await callback.answer()

@dp.callback_query(F.data.startswith("cancel_"))
async def cancel_order(callback: types.CallbackQuery):
    oid = callback.data.replace("cancel_", "")
    if oid in orders:
        orders[oid]["status"] = "cancelled"
        await callback.message.answer("❌ Заказ отменён")
    await callback.answer()

async def main():
    print("✅ Бот запущен!")
    await dp.start_polling(bot)

if __name__ == "__main__":
    asyncio.run(main())
EOF