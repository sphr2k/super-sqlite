# SuperSQLite - SuperJSON-powered SQLite

SuperSQLite is a **schema-less** but **strictly typed** database layer for SQLite that handles rich JavaScript types (Date, Set, Map, BigInt) transparently.

- **ArkType**: For runtime validation and TypeScript type inference (Source of Truth).
- **SuperJSON**: To serialize/deserialize rich types (Date, Set, Map) transparently.
- **Drizzle ORM**: For database interactions.
- **SQLite**: As the backing store (using `better-sqlite3`).

## Key Features

- 🛡️ **Strict Runtime Typing**: Powered by ArkType for bulletproof data integrity.
- 📦 **Rich Type Support**: Store `Date`, `Set`, `Map`, `BigInt`, and `RegExp` directly in SQLite.
- 🏎️ **Expression Indexes**: Automatically creates SQLite expression indexes for fast JSON queries.
- 🔌 **Seamless Drizzle Integration**: Leverages Drizzle ORM for a familiar developer experience.
- 🏗️ **Zero Migrations**: Add or remove fields from your documents without painful SQL migrations.

## How it works

1. **Define Schema**: You define your data model using ArkType.
2. **Generic Factory**: A helper function (`arktypeJsonTable`) creates a Drizzle table definition with a single `data` blob column.
3. **Expression Indexes**: Automatically creates SQLite expression indexes on specialized fields for efficient querying.
4. **Insert & Query**: 
   - Data is validated against the ArkType schema.
   - Serialized via SuperJSON (preserving rich types).
   - Stored as a JSON string.
   - Queries use `json_extract` and leverage indexes for performance.
   - Results are automatically hydrated back to their original rich types.

## Getting Started

1. Install dependencies:
   ```bash
   npm install
   ```

2. Run the basic example:
   ```bash
   npm start
   ```

3. Run the e-commerce benchmark (Joins & Performance):
   ```bash
   npm run ecommerce:bench
   ```

## Example Usage

```typescript
import { type } from "arktype";
import { arktypeJsonTable } from "./factory";

// 1. Define your schema
const UserSchema = type({
    id: "string",
    name: "string",
    email: "email",
    roles: "string[]",
    createdAt: "Date"
});

// 2. Initialize the table
const users = arktypeJsonTable('User', UserSchema, 'users', db, [
    'email', 
    'createdAt'
]);

// 3. Use it!
const newUser = {
    id: "user_1",
    name: "John Doe",
    email: "john@example.com",
    roles: ["admin"],
    createdAt: new Date()
};

await users.insert(newUser);
const results = await users.findByField('email', 'john@example.com');
```

## Expression Indexes for Performance

SuperSQLite automatically creates **SQLite expression indexes** on JSON fields to ensure efficient queries. You can specify which fields to index:

```typescript
const repo = arktypeJsonTable('User', UserSchema, 'users', db, [
    'email',      // Index for fast email lookups
    'status',     // Index for querying by status
    'createdAt'   // Index for date range queries
]);
```

**Benefits:**
- ✅ **Fast queries** on indexed fields (O(log n) instead of O(n) table scans)
- ✅ **No schema migration** needed when adding/removing indexes (just edit the array)
- ✅ **Selective indexing** - only index fields you actually query

## Query Capabilities

### ✅ Native Support
- **Primitive Fields**: String, Number, Boolean, Null.
- **Dates**: Built-in support for date range queries.

### ⚠️ Advanced Types (Queryable via json_extract)
- **Sets/Maps**: Stored as JSON arrays/entries.
- **BigInt**: Stored as strings.

## Relational Data (Joins)

SuperSQLite supports relational modeling by using indexed foreign key fields. While data is stored as JSON, you can perform efficient joins in application logic or via native SQL.

See `src/benchmark.ts` for a complete example of joins across Users, Products, and Orders using indexed lookups.
