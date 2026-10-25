import Database from 'better-sqlite3';
import { BetterSQLite3Adapter } from './adapters/better-sqlite3.js';
import { arktypeJsonTable } from './factory.js';
import { faker } from '@faker-js/faker';
import { User, Product, Order, OrderItem } from './ecommerce-schemas.js';
import type { User as UserType, Product as ProductType, Order as OrderType, OrderItem as OrderItemType } from './ecommerce-schemas.js';

// Create persistent database
const sqlite = new Database('ecommerce-benchmark.db');
const db = new BetterSQLite3Adapter(sqlite);

// Create repos with indexes
const userRepo = arktypeJsonTable('User', User, 'users', db, ['username', 'email']);
const productRepo = arktypeJsonTable('Product', Product, 'products', db, ['id', 'category', 'inStock']);
const orderRepo = arktypeJsonTable('Order', Order, 'orders', db, ['userId', 'status', 'createdAt']);
const orderItemRepo = arktypeJsonTable('OrderItem', OrderItem, 'order_items', db, ['orderId', 'productId']);

async function seed() {
    console.log("\n🌱 \x1b[1mSeeding E-Commerce Benchmark Database\x1b[0m\n");
    console.log("📁 Database: ecommerce-benchmark.db\n");

    // Initialize tables
    console.log("🔧 Initializing tables and indexes...");
    await Promise.all([
        userRepo.initialize(),
        productRepo.initialize(),
        orderRepo.initialize(),
        orderItemRepo.initialize()
    ]);
    console.log("✅ Tables ready\n");

    // Scale: 5x original (5000 users, 2500 products, 50000 orders)
    const NUM_USERS = 5000;
    const NUM_PRODUCTS = 2500;
    const NUM_ORDERS = 50000;

    console.log("📊 Dataset size:");
    console.log(`   • ${NUM_USERS.toLocaleString()} users`);
    console.log(`   • ${NUM_PRODUCTS.toLocaleString()} products`);
    console.log(`   • ${NUM_ORDERS.toLocaleString()} orders`);
    console.log(`   • ~${(NUM_ORDERS * 3).toLocaleString()} order items (estimated)\n`);

    const totalStart = performance.now();

    // Seed users
    console.log(`👥 Generating ${NUM_USERS.toLocaleString()} users...`);
    const userStart = performance.now();
    const users: User[] = Array.from({ length: NUM_USERS }, (_, i) => ({
        id: `u${i + 1}`,
        username: faker.internet.username(),
        email: faker.internet.email(),
        createdAt: faker.date.past()
    }));
    await userRepo.insert(users);
    console.log(`✅ ${NUM_USERS.toLocaleString()} users in ${(performance.now() - userStart).toFixed(0)}ms\n`);

    // Seed products
    console.log(`📦 Generating ${NUM_PRODUCTS.toLocaleString()} products...`);
    const prodStart = performance.now();
    const categories: Array<'electronics' | 'books' | 'clothing'> = ['electronics', 'books', 'clothing'];
    const products: Product[] = Array.from({ length: NUM_PRODUCTS }, (_, i) => ({
        id: `p${i + 1}`,
        name: faker.commerce.productName(),
        price: parseFloat(faker.commerce.price({ min: 10, max: 2000 })),
        category: faker.helpers.arrayElement(categories),
        inStock: faker.datatype.boolean(0.85),
        createdAt: faker.date.recent()
    }));
    await productRepo.insert(products);
    console.log(`✅ ${NUM_PRODUCTS.toLocaleString()} products in ${(performance.now() - prodStart).toFixed(0)}ms\n`);

    // Seed orders and items together to calculate totals correctly
    console.log(`🛒 Generating ${NUM_ORDERS.toLocaleString()} orders and items...`);
    const shopStart = performance.now();
    let itemCount = 0;
    const statuses: Array<'pending' | 'shipped' | 'delivered' | 'cancelled'> =
        ['pending', 'shipped', 'delivered', 'cancelled'];

    const pendingOrders: OrderType[] = [];
    const pendingItems: OrderItemType[] = [];
    for (let i = 0; i < NUM_ORDERS; i++) {
        const numItems = faker.number.int({ min: 1, max: 4 });
        const user = faker.helpers.arrayElement(users);
        const orderId = `o${i + 1}`;
        const orderItems: OrderItemType[] = [];
        let totalAmount = 0;

        for (let j = 0; j < numItems; j++) {
            const product = faker.helpers.arrayElement(products);
            const quantity = faker.number.int({ min: 1, max: 3 });
            const item: OrderItemType = {
                id: `oi${++itemCount}`,
                orderId: orderId,
                productId: product.id,
                quantity,
                priceAtTime: product.price
            };
            orderItems.push(item);
            totalAmount += product.price * quantity;
        }

        // Insert Order WITH the calculated total
        pendingOrders.push({
            id: orderId,
            userId: user.id,
            status: faker.helpers.arrayElement(statuses),
            totalAmount,
            createdAt: faker.date.recent({ days: 60 }) // More spread for date queries
        });

        // Insert items
        pendingItems.push(...orderItems);
        if (pendingOrders.length >= 100) {
            await orderRepo.insert(pendingOrders.splice(0));
            await orderItemRepo.insert(pendingItems.splice(0));
        }

        if ((i + 1) % 10000 === 0) console.log(`   ...processed ${i + 1} orders`);
    }
    if (pendingOrders.length) await orderRepo.insert(pendingOrders);
    if (pendingItems.length) await orderItemRepo.insert(pendingItems);
    console.log(`✅ ${NUM_ORDERS.toLocaleString()} orders and ${itemCount.toLocaleString()} items in ${(performance.now() - shopStart).toFixed(0)}ms\n`);

    const totalTime = performance.now() - totalStart;
    const totalRecords = NUM_USERS + NUM_PRODUCTS + NUM_ORDERS + itemCount;

    console.log("═".repeat(60));
    console.log(`\n🎉 Seeding complete!`);
    console.log(`   💾 Total records: ${totalRecords.toLocaleString()}`);
    console.log(`   ⏱️  Total time: ${(totalTime / 1000).toFixed(2)}s`);
    console.log(`   📁 Saved to: ecommerce-benchmark.db\n`);
    console.log("Run benchmarks with: npm run bench\n");

    sqlite.close();
}

seed().catch(console.error);
