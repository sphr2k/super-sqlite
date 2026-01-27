import { type } from 'arktype';

// Shared schema definitions for e-commerce demo and benchmarks

export const User = type({
    id: "string",
    username: "string",
    email: "string",
    createdAt: type.instanceOf(Date)
});

export const Product = type({
    id: "string",
    name: "string",
    price: "number",
    category: "'electronics' | 'books' | 'clothing'",
    inStock: "boolean",
    createdAt: type.instanceOf(Date)
});

export const Order = type({
    id: "string",
    userId: "string",
    status: "'pending' | 'shipped' | 'delivered' | 'cancelled'",
    totalAmount: "number",
    createdAt: type.instanceOf(Date)
});

export const OrderItem = type({
    id: "string",
    orderId: "string",
    productId: "string",
    quantity: "number",
    priceAtTime: "number"
});

// Type inference
export type User = typeof User.infer;
export type Product = typeof Product.infer;
export type Order = typeof Order.infer;
export type OrderItem = typeof OrderItem.infer;
