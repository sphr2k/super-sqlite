import { describe, it, expect, beforeEach } from 'vitest';
import { type } from 'arktype';
import { db } from './db.js';
import { arktypeJsonTable } from './factory.js';

// Define a Comprehensive Schema covering all common types
const TestSchema = type({
    id: "string",                   // Standard ID
    name: "string",                 // Standard String
    age: "number",                  // Standard Number
    isActive: "boolean",            // Boolean
    "optionalBool?": "boolean",     // Optional Boolean
    role: "'admin' | 'user'",       // Enum
    metadata: "unknown",            // JSON Object
    tags: type.instanceOf(Set),     // Set (Rich Type)
    createdAt: type.instanceOf(Date)// Date (Rich Type)
});

type TestType = typeof TestSchema.infer;

const repo = arktypeJsonTable('TestEntity', TestSchema, 'test_entities', db, [
    'name', 'age', 'isActive', 'optionalBool', 'role', 'createdAt'
]);

describe('SuperSQLite Repository', async () => {

    beforeEach(async () => {
        await repo.initialize();
        await db.run({ sql: 'DELETE FROM test_entities' });
    });

    it('should insert and retrieve a record with all types correctly', async () => {
        const now = new Date();
        const data = {
            id: "uuid-1",
            name: "Test User",
            age: 25,
            isActive: true,
            role: "admin" as const,
            metadata: { foo: "bar" },
            tags: new Set(["a", "b"]),
            createdAt: now
        };

        const inserted = await repo.insert(data);
        expect(inserted.id).toBeDefined();

        const retrieved = await repo.findById(inserted.id);

        expect(retrieved).toBeDefined();
        expect(retrieved?.name).toBe("Test User");
        expect(retrieved?.age).toBe(25);
        expect(retrieved?.isActive).toBe(true);
        expect(retrieved?.role).toBe("admin");

        // Check Rich Types Hydration
        expect(retrieved?.createdAt).toBeInstanceOf(Date);
        expect(retrieved?.createdAt.toISOString()).toBe(now.toISOString());

        expect(retrieved?.tags).toBeInstanceOf(Set);
        expect(retrieved?.tags.has("a")).toBe(true);
        expect(retrieved?.tags.has("b")).toBe(true);

        // Check JSON Object
        expect((retrieved?.metadata as any).foo).toBe("bar");
    });

    it('should query by boolean fields (true/false)', async () => {
        await repo.insert({ id: "1", name: "Active", age: 20, isActive: true, role: "user", tags: new Set(), createdAt: new Date(), metadata: {} });
        await repo.insert({ id: "2", name: "Inactive", age: 20, isActive: false, role: "user", tags: new Set(), createdAt: new Date(), metadata: {} });

        const activeParams = await repo.findByField('isActive', true);
        expect(activeParams).toHaveLength(1);
        expect(activeParams[0].name).toBe("Active");

        const inactiveParams = await repo.findByField('isActive', false);
        expect(inactiveParams).toHaveLength(1);
        expect(inactiveParams[0].name).toBe("Inactive");
    });

    it('should query by optional boolean fields (undefined)', async () => {
        // One with value, one without
        await repo.insert({ id: "1", name: "HasBool", age: 20, isActive: true, optionalBool: true, role: "user", tags: new Set(), createdAt: new Date(), metadata: {} });
        await repo.insert({ id: "2", name: "NoBool", age: 20, isActive: true, role: "user", tags: new Set(), createdAt: new Date(), metadata: {} });

        const missing = await repo.findByField('optionalBool', undefined);
        expect(missing).toHaveLength(1);
        expect(missing[0].name).toBe("NoBool");
    });

    it('should query by Enum fields', async () => {
        await repo.insert({ id: "1", name: "Admin", age: 20, isActive: true, role: "admin", tags: new Set(), createdAt: new Date(), metadata: {} });
        await repo.insert({ id: "2", name: "User", age: 20, isActive: true, role: "user", tags: new Set(), createdAt: new Date(), metadata: {} });

        const admins = await repo.findByField('role', 'admin');
        expect(admins).toHaveLength(1);
        expect(admins[0].name).toBe("Admin");
    });

    it('should query by Date Range', async () => {
        const today = new Date();
        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);

        const lastWeek = new Date(today);
        lastWeek.setDate(lastWeek.getDate() - 7);

        await repo.insert({ id: "1", name: "Today", age: 20, isActive: true, role: "user", tags: new Set(), createdAt: today, metadata: {} });
        await repo.insert({ id: "2", name: "LastWeek", age: 20, isActive: true, role: "user", tags: new Set(), createdAt: lastWeek, metadata: {} });

        // Find created since yesterday
        const searchStart = new Date(yesterday.getTime() - 1000);

        const recent = await repo.findDateRange('createdAt', { start: searchStart });
        expect(recent).toHaveLength(1);
        expect(recent[0].name).toBe("Today");
    });

    it('should reject invalid data via ArkType validation', async () => {
        await expect(repo.insert({
                id: "1",
                name: "Bad User",
                role: "SUPER_ADMIN" as any, // Invalid Enum
                isActive: true,
                age: 20,
                tags: new Set(),
                createdAt: new Date(),
                metadata: {}
            })).rejects.toThrow(/Validation Error/);
    });

});
