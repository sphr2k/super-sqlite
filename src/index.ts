import { type } from 'arktype';
import { db } from './db.js';
import { arktypeJsonTable } from './factory.js';

// 1. Define your schema using ArkType
// "date" matches a Date object
// "Set<string>" matches a Set containing strings
const User = type({
    name: "string",
    email: "string",
    status: "'pending' | 'active' | 'banned'",
    createdAt: type.instanceOf(Date),
    roles: type.instanceOf(Set),
    "metadata?": "unknown"
});

// 2. Create the "table" wrapper
const usersRepo = arktypeJsonTable('User', User, 'users', db);

const Profile = type({
    userId: "string",
    bio: "string",
    website: "string?"
});

const profilesRepo = arktypeJsonTable('Profile', Profile, 'profiles', db, ['userId']);

async function main() {
    console.log("🚀 Initializing DB...");
    await usersRepo.initialize();
    await profilesRepo.initialize();

    console.log("\n📝 Inserting data using flat objects (Auto-SuperJSON)...");
    try {
        const newUser = await usersRepo.insert({
            name: "Alice Dev",
            email: "alice@example.com",
            status: "pending",
            createdAt: new Date(),
            roles: new Set(["admin", "editor"])
        }) as any;

        await profilesRepo.insert({
            userId: newUser.id,
            bio: "Building the future with SuperSQLite",
            website: "https://github.com/jan-werner/supersqlite"
        });

        await usersRepo.insert({
            name: "NoProfile Bob",
            email: "bob@example.com",
            status: "active",
            createdAt: new Date(),
            roles: new Set(["viewer"])
        });

        console.log("\n✨ PERFECT DX: Fluent Select + Object Where Filters");
        // Magical partial selection + magical object-based where clause!
        const activeUsers = await usersRepo.select({ name: true, email: true })
            .where({ status: "active" })
            .all();

        console.log(`✅ Found ${activeUsers.length} active users (Partial Selection):`);
        activeUsers.forEach((u: any) => console.log(`   👤 ${u.name} <${u.email}>`));

        console.log("\n🔗 MAGIC JOIN: Users with Profiles");
        const usersWithProfiles = await usersRepo.leftJoin(profilesRepo, { id: 'userId' })
            .select()
            .all();

        usersWithProfiles.forEach((u: any) => {
            const profileText = u.profiles
                ? `✅ Bio: ${u.profiles.bio}`
                : `❌ No profile found`;
            const name = u.users?.name || 'Unknown';
            console.log(`   👤 User: ${name.padEnd(15)} | ${profileText}`);
        });

        console.log("\n🎯 NESTED FILTER: Users with specific Bio");
        const filteredJoins = await usersRepo.join(profilesRepo, { id: 'userId' })
            .where({ profiles: { bio: "Building the future with SuperSQLite" } })
            .all();

        filteredJoins.forEach((u: any) => {
            console.log(`   ✅ Found: ${u.users.name} (${u.profiles.bio})`);
        });

        console.log("\n📅 RANGE QUERY: Users created since yesterday");
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);

        // findDateRange still works and uses the proxy internally
        const recentUsers = await usersRepo.findDateRange("createdAt", { start: yesterday });
        console.log(`✅ Found ${recentUsers.length} users created since ${yesterday.toISOString()}`);

    } catch (e: any) {
        console.error("❌ Error:", e.message);
    }
}

main();
