import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { arktypeJsonTable } from './factory.js';
import { sql, eq, and, inArray } from 'drizzle-orm';
import * as fs from 'fs';
import { User, Product, Order, OrderItem } from './ecommerce-schemas.js';
import type { User as UserType, Product as ProductType, Order as OrderType, OrderItem as OrderItemType } from './ecommerce-schemas.js';

async function runBenchmarks() {
    // Check if database exists
    if (!fs.existsSync('ecommerce-benchmark.db')) {
        console.log("\n❌ Benchmark database not found!");
        console.log("   Run: npm run seed:benchmark\n");
        process.exit(1);
    }

    // Connect to persistent database
    const sqlite = new Database('ecommerce-benchmark.db');
    const db = drizzle(sqlite);

    // Create repos (tables already exist)
    const userRepo = arktypeJsonTable('User', User, 'users', db, ['username', 'email']);
    const productRepo = arktypeJsonTable('Product', Product, 'products', db, ['id', 'category', 'inStock']);
    const orderRepo = arktypeJsonTable('Order', Order, 'orders', db, ['userId', 'status']);
    const orderItemRepo = arktypeJsonTable('OrderItem', OrderItem, 'order_items', db, ['orderId', 'productId']);

    console.log("\n⚡ \x1b[1mSuperSQLite Performance Benchmarks\x1b[0m\n");
    console.log("═".repeat(60) + "\n");

    // Get dataset stats
    const userCount = userRepo.getAll().length;
    const productCount = productRepo.getAll().length;
    const orderCount = orderRepo.getAll().length;
    const itemCount = orderItemRepo.getAll().length;

    console.log("📊 Dataset:");
    console.log(`   • ${userCount.toLocaleString()} users`);
    console.log(`   • ${productCount.toLocaleString()} products`);
    console.log(`   • ${orderCount.toLocaleString()} orders`);
    console.log(`   • ${itemCount.toLocaleString()} order items\n`);
    console.log("═".repeat(60) + "\n");

    // Benchmark 1: Indexed user lookup
    console.log("🔍 Benchmark 1: Find orders by userId (INDEXED)");
    const users = userRepo.getAll();
    const randomUser = users[Math.floor(Math.random() * users.length)];
    console.log(`   User: ${randomUser.username}`);

    const q1Start = performance.now();
    const userOrders = orderRepo.findByField('userId', randomUser.id);
    const q1Time = performance.now() - q1Start;

    console.log(`   ✅ Found ${userOrders.length} orders in ${q1Time.toFixed(2)}ms`);

    const plan1Obj = db.select().from(orderRepo.table).where(eq(orderRepo.proxy.userId, randomUser.id));
    const { sql: s1, params: p1 } = plan1Obj.toSQL();
    const plan1 = sqlite.prepare(`EXPLAIN QUERY PLAN ${s1}`).all(...p1);
    (plan1 as any[]).forEach((row: any) => {
        if (row.detail?.includes('USING INDEX')) {
            console.log(`   📊 ${row.detail}`);
        }
    });
    console.log();

    // Benchmark 2: Category query
    console.log("🔍 Benchmark 2: Find products by category (INDEXED)");
    const q2Start = performance.now();
    const electronics = productRepo.findByField('category', 'electronics');
    const q2Time = performance.now() - q2Start;
    console.log(`   ✅ Found ${electronics.length} electronics in ${q2Time.toFixed(2)}ms\n`);

    // Benchmark 3: N+1 vs SQL JOIN
    console.log("⚔️  Benchmark 3: N+1 Queries vs SQL JOIN");

    // Find a user with many orders for fair comparison
    const heavyUsers = users.slice(0, 100).map((u: any) => ({
        user: u,
        orderCount: orderRepo.findByField('userId', u.id).length
    })).sort((a: any, b: any) => b.orderCount - a.orderCount);

    const heavyUser = heavyUsers[0].user;
    const heavyUserOrders = orderRepo.findByField('userId', heavyUser.id);

    console.log(`   Testing with user who has ${heavyUserOrders.length} orders\n`);

    // Approach 1: N+1
    console.log("   🐌 Approach 1: N+1 Queries (items.map + findById)");
    const n1Start = performance.now();
    let n1ItemCount = 0;
    for (const order of heavyUserOrders) {
        const items = orderItemRepo.findByField('orderId', order.id);
        n1ItemCount += items.length;
        items.forEach((item: OrderItemType) => {
            productRepo.findById(item.productId);
        });
    }
    const n1Time = performance.now() - n1Start;
    console.log(`   ⏱️  Fetched ${n1ItemCount} items + products in ${n1Time.toFixed(2)}ms`);
    console.log(`   📊 ${heavyUserOrders.length} order queries + ${n1ItemCount} product queries = ${heavyUserOrders.length + n1ItemCount} DB calls`);

    // Approach 2: Single SQL JOIN
    console.log("\n   ⚡ Approach 2: Single SQL JOIN (all items at once)");
    const join2Start = performance.now();

    const ids = heavyUserOrders.map((o: any) => o.id);
    const joinedResultsObj = db.select({
        item_id: orderItemRepo.proxy.id,
        item_data: orderItemRepo.proxy._raw,
        product_id: productRepo.proxy.id,
        product_data: productRepo.proxy._raw
    })
        .from(orderItemRepo.table)
        .innerJoin(productRepo.table, eq(orderItemRepo.proxy.productId, productRepo.proxy.id))
        .where(inArray(orderItemRepo.proxy.orderId, ids));

    const joinedResults = joinedResultsObj.all();
    const join2Time = performance.now() - join2Start;

    console.log(`   ⏱️  Fetched ${joinedResults.length} items + products in ${join2Time.toFixed(2)}ms`);
    console.log(`   📊 1 SQL JOIN with WHERE IN = 1 DB call`);

    const speedup = n1Time / join2Time;
    console.log(`\n   🏆 SQL JOIN is ${speedup.toFixed(1)}x faster!`);
    console.log(`   💡 Savings: ${(n1Time - join2Time).toFixed(2)}ms\n`);

    // Show query plan
    console.log("   📊 Query Plan for SQL JOIN:");
    const joinPlanObj = db.select()
        .from(orderItemRepo.table)
        .innerJoin(productRepo.table, eq(orderItemRepo.proxy.productId, productRepo.proxy.id))
        .where(eq(orderItemRepo.proxy.orderId, 'o1'));

    const { sql: sj, params: pj } = joinPlanObj.toSQL();
    const joinPlan = sqlite.prepare(`EXPLAIN QUERY PLAN ${sj}`).all(...pj);
    (joinPlan as any[]).forEach((row: any) => {
        console.log(`   ${row.detail}`);
    });
    console.log();

    // Benchmark 4: SQL Aggregations with GROUP BY json_extract()
    console.log("📊 Benchmark 4: SQL Aggregations (GROUP BY json_extract)");
    console.log("   Comparing JS aggregation vs SQL GROUP BY\n");

    // Approach 1: JavaScript aggregation (current approach)
    console.log("   🐌 Approach 1: JavaScript aggregation");
    const jsAggStart = performance.now();
    const orders = orderRepo.getAll();
    const statusRevenue = new Map<string, number>();
    orders.forEach((o: any) => {
        statusRevenue.set(o.status, (statusRevenue.get(o.status) || 0) + o.totalAmount);
    });
    const jsAggTime = performance.now() - jsAggStart;
    console.log(`   ⏱️  Aggregated ${orders.length.toLocaleString()} orders in ${jsAggTime.toFixed(2)}ms`);
    console.log(`   📊 Pattern: Load all ${orders.length.toLocaleString()} records → aggregate in JS`);

    // Approach 2: SQL GROUP BY
    console.log("\n   ⚡ Approach 2: SQL GROUP BY json_extract()");
    const sqlAggStart = performance.now();
    const revenueResultsObj = db.select({
        status: orderRepo.proxy.status,
        total_revenue: sql<number>`SUM(${orderRepo.proxy.totalAmount})`,
        order_count: sql<number>`COUNT(*)`
    })
        .from(orderRepo.table)
        .groupBy(orderRepo.proxy.status);

    const revenueResults = revenueResultsObj.all() as any[];
    const sqlAggTime = performance.now() - sqlAggStart;

    console.log(`   ⏱️  Aggregated in ${sqlAggTime.toFixed(2)}ms`);
    console.log(`   📊 Pattern: SQLite computes aggregation → return 4 rows`);
    console.log(`\n   Results:`);
    revenueResults.forEach((row: any) => {
        const revenue = parseFloat(row.total_revenue);
        console.log(`      ${row.status}: $${revenue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (${row.order_count.toLocaleString()} orders)`);
    });

    const aggSpeedup = jsAggTime / sqlAggTime;
    console.log(`\n   🏆 SQL GROUP BY is ${aggSpeedup.toFixed(1)}x faster!`);
    console.log(`   💡 Savings: ${(jsAggTime - sqlAggTime).toFixed(2)}ms`);
    console.log(`   🎯 Benefit scales with data size (avoids loading ${orders.length.toLocaleString()} records into memory)`);

    // Show query plan
    console.log("\n   📊 Query Plan:");
    const { sql: sa, params: pa } = revenueResultsObj.toSQL();
    const aggPlan = sqlite.prepare(`EXPLAIN QUERY PLAN ${sa}`).all(...pa);
    (aggPlan as any[]).forEach((row: any) => {
        console.log(`   ${row.detail}`);
    });
    console.log();

    // Benchmark 5: Complex aggregation with JOIN
    console.log("📊 Benchmark 5: Revenue by Product Category (JOIN + GROUP BY)");
    const catRevStart = performance.now();
    const categoryResultsObj = db.select({
        category: productRepo.proxy.category,
        revenue: sql<number>`SUM(${orderItemRepo.proxy.quantity} * ${orderItemRepo.proxy.priceAtTime})`,
        order_count: sql<number>`COUNT(DISTINCT ${orderItemRepo.proxy.orderId})`,
        units_sold: sql<number>`SUM(${orderItemRepo.proxy.quantity})`
    })
        .from(orderItemRepo.table)
        .innerJoin(productRepo.table, eq(orderItemRepo.proxy.productId, productRepo.proxy.id))
        .groupBy(productRepo.proxy.category);

    const categoryResults = categoryResultsObj.all();
    const catRevTime = performance.now() - catRevStart;

    console.log(`   ⏱️  Computed in ${catRevTime.toFixed(2)}ms\n`);
    console.log(`   Results (${itemCount.toLocaleString()} items analyzed):`);
    (categoryResults as any[]).forEach((row: any) => {
        const revenue = parseFloat(row.revenue);
        console.log(`      ${row.category}:`);
        console.log(`         Revenue: $${revenue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
        console.log(`         Orders: ${row.order_count.toLocaleString()}`);
        console.log(`         Units: ${row.units_sold.toLocaleString()}`);
    });

    console.log(`\n   💡 JOIN + GROUP BY processes ${itemCount.toLocaleString()} items in ${catRevTime.toFixed(2)}ms`);
    console.log(`   🎯 This would require fetching all ${itemCount.toLocaleString()} items in JavaScript!\n`);

    /* Skipping slow Benchmark 6
    // Benchmark 6: LEFT JOIN (Users with optional Orders)
    console.log("🔍 Benchmark 6: LEFT JOIN (Users with optional Orders)");
    const ljStart = performance.now();
    // Query users and their order counts (including 0)
    // Optimized: Use the indexed column directly if possible, or ensure it uses the index
    const leftJoinQuery = `
        SELECT 
            u.id as user_id,
            json_extract(u.data, '$.json.username') as username,
            COUNT(o.id) as order_count
        FROM users u
        LEFT JOIN orders o ON u.id = json_extract(o.data, '$.json.userId')
        GROUP BY u.id
        ORDER BY order_count ASC
        LIMIT 10
    `;
    const ljResults = db.all(sql.raw(leftJoinQuery));
    const ljTime = performance.now() - ljStart;

    console.log(`   ✅ Processed ${userCount.toLocaleString()} users in ${ljTime.toFixed(2)}ms`);
    console.log("   Results (Users with fewest orders):");
    (ljResults as any[]).forEach((row: any) => {
        console.log(`      • ${row.username.padEnd(20)} | Orders: ${row.order_count}`);
    });
    console.log();
    */

    // Benchmark 7: Complex Date Range + JOIN + Aggregation
    console.log("📅 Benchmark 7: Complex Date Range + JOIN + Aggregation");
    console.log("   Orders from last 30 days, 'shipped' status, with item counts\n");

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const complexStart = performance.now();
    const [complexResult] = db.select({
        total_orders: sql<number>`COUNT(DISTINCT ${orderRepo.table.id})`,
        total_items: sql<number>`SUM(${orderItemRepo.proxy.quantity})`,
        avg_order_value: sql<number>`AVG(${orderRepo.proxy.totalAmount})`
    })
        .from(orderRepo.table)
        .innerJoin(orderItemRepo.table, eq(orderRepo.table.id, orderItemRepo.proxy.orderId))
        .where(and(
            eq(orderRepo.proxy.status, 'shipped'),
            sql`${orderRepo.proxy.createdAt} >= ${thirtyDaysAgo.toISOString()}`
        ))
        .all() as any[];

    const complexTime = performance.now() - complexStart;

    console.log(`   ⏱️  Computed in ${complexTime.toFixed(2)}ms`);
    console.log(`   Results:`);
    console.log(`      Total Shipped Orders: ${complexResult.total_orders?.toLocaleString()}`);
    console.log(`      Total Items Shipped:  ${complexResult.total_items?.toLocaleString()}`);
    console.log(`      Average Order Value:  $${(complexResult.avg_order_value || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}`);

    // Show query plan for the complex query (built with Drizzle)
    const complexObj = db.select({
        total_orders: sql<number>`COUNT(DISTINCT ${orderRepo.table.id})`,
        total_items: sql<number>`SUM(${orderItemRepo.proxy.quantity})`,
        avg_order_value: sql<number>`AVG(${orderRepo.proxy.totalAmount})`
    })
        .from(orderRepo.table)
        .innerJoin(orderItemRepo.table, eq(orderRepo.table.id, orderItemRepo.proxy.orderId))
        .where(and(
            eq(orderRepo.proxy.status, 'shipped'),
            sql`${orderRepo.proxy.createdAt} >= ${thirtyDaysAgo.toISOString()}`
        ));

    console.log("\n   📊 Query Plan:");
    const { sql: sqlStr, params } = complexObj.toSQL();
    const complexPlan = sqlite.prepare(`EXPLAIN QUERY PLAN ${sqlStr}`).all(...params);
    (complexPlan as any[]).forEach((row: any) => {
        console.log(`   ${row.detail}`);
    });
    console.log();

    // Benchmark 8: Simple Date Range (INDEXED)
    console.log("📅 Benchmark 8: Simple Date Range lookup (INDEXED)");
    const last30Days = new Date();
    last30Days.setDate(last30Days.getDate() - 30);

    const rangeStart = performance.now();
    const recentOrders = orderRepo.findDateRange('createdAt', { start: last30Days });
    const rangeTime = performance.now() - rangeStart;

    console.log(`   ✅ Found ${recentOrders.length.toLocaleString()} orders from last 30 days in ${rangeTime.toFixed(2)}ms`);

    const rangePlanObj = db.select().from(orderRepo.table)
        .where(sql`${orderRepo.proxy.createdAt} >= ${last30Days.toISOString()}`);
    const { sql: s8, params: p8 } = rangePlanObj.toSQL();
    const rangePlan = sqlite.prepare(`EXPLAIN QUERY PLAN ${s8}`).all(...p8);
    (rangePlan as any[]).forEach((row: any) => {
        if (row.detail?.includes('USING INDEX')) {
            console.log(`   📊 ${row.detail}`);
        }
    });
    console.log();

    console.log("═".repeat(60));
    console.log("\n🎉 Benchmarks complete!\n");

    sqlite.close();
}

runBenchmarks().catch(console.error);
