// Complex Error Generator Lambda Function
// Simulates a realistic data pipeline failure caused by a schema version mismatch.
//
// Scenario: The upstream system upgraded the order export format from v2 (flat) to v3
// (nested), but this Lambda was never updated to handle the new schema.
//
// Pipeline: S3 GetObject → JSON Parse → Data Transform (fails here) → DynamoDB PutItem
//
// The S3 read and JSON parse succeed, but the transform step crashes with a TypeError
// because the code expects flat fields (e.g., order.amount) but the v3 schema nests
// them under order.pricing.amount.

const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { DynamoDBClient, PutItemCommand } = require('@aws-sdk/client-dynamodb');

const s3Client = new S3Client();
const dynamoClient = new DynamoDBClient();

const generateCorrelationId = () =>
  `pipeline-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;

// ============================================================
// Seed data: v3 format (nested structure)
// The upstream order-export service was upgraded to v3 on 2026-04-10
// ============================================================
const V3_ORDER_DATA = {
  orders: [
    {
      orderId: 'ORD-20260415-001',
      customer: { id: 'CUST-1042', tier: 'premium', region: 'ap-northeast-1' },
      pricing: { amount: 15800, currency: 'JPY', tax: 1580, discount: 0 },
      fulfillment: { status: 'confirmed', items: 3, warehouse: 'TYO-2' }
    },
    {
      orderId: 'ORD-20260415-002',
      customer: { id: 'CUST-2087', tier: 'standard', region: 'ap-northeast-1' },
      pricing: { amount: 4200, currency: 'JPY', tax: 420, discount: 200 },
      fulfillment: { status: 'confirmed', items: 1, warehouse: 'TYO-1' }
    },
    {
      orderId: 'ORD-20260415-003',
      customer: { id: 'CUST-0553', tier: 'premium', region: 'ap-northeast-1' },
      pricing: { amount: 32400, currency: 'JPY', tax: 3240, discount: 1500 },
      fulfillment: { status: 'pending_payment', items: 5, warehouse: 'TYO-2' }
    }
  ],
  exportedAt: new Date().toISOString(),
  schemaVersion: '3.0.0'
};

exports.handler = async (event) => {
  const correlationId = generateCorrelationId();
  const startTime = Date.now();

  console.log(JSON.stringify({
    level: 'INFO', correlationId,
    message: 'Order data ingestion pipeline started',
    trigger: event.source || 'manual',
    timestamp: new Date().toISOString()
  }));

  const bucketName = process.env.DATA_BUCKET_NAME;
  const tableName = process.env.TABLE_NAME;
  const dataKey = 'incoming/order-events.json';

  // ============================================================
  // Step 1: Seed v3 data to S3
  // ============================================================
  try {
    console.log(JSON.stringify({
      level: 'INFO', correlationId, step: '1/4',
      message: 'Seeding order export data to S3',
      bucket: bucketName, key: dataKey
    }));

    await s3Client.send(new PutObjectCommand({
      Bucket: bucketName,
      Key: dataKey,
      Body: JSON.stringify(V3_ORDER_DATA),
      ContentType: 'application/json'
    }));

    console.log(JSON.stringify({
      level: 'INFO', correlationId, step: '1/4',
      message: 'Order data seeded successfully',
      recordCount: V3_ORDER_DATA.orders.length,
      schemaVersion: V3_ORDER_DATA.schemaVersion,
      elapsedMs: Date.now() - startTime
    }));
  } catch (err) {
    console.error(JSON.stringify({
      level: 'ERROR', correlationId, step: '1/4',
      message: 'Failed to seed data to S3',
      errorName: err.name, errorMessage: err.message
    }));
    throw err;
  }

  // ============================================================
  // Step 2: Read order data from S3
  // ============================================================
  let rawData;
  try {
    console.log(JSON.stringify({
      level: 'INFO', correlationId, step: '2/4',
      message: 'Reading order data from S3',
      bucket: bucketName, key: dataKey
    }));

    const s3Response = await s3Client.send(new GetObjectCommand({
      Bucket: bucketName, Key: dataKey
    }));
    rawData = await s3Response.Body.transformToString();

    console.log(JSON.stringify({
      level: 'INFO', correlationId, step: '2/4',
      message: 'S3 read completed successfully',
      fileSizeKB: (Buffer.byteLength(rawData, 'utf8') / 1024).toFixed(2),
      contentType: s3Response.ContentType,
      elapsedMs: Date.now() - startTime
    }));
  } catch (err) {
    console.error(JSON.stringify({
      level: 'ERROR', correlationId, step: '2/4',
      message: 'Failed to read from S3',
      errorName: err.name, errorMessage: err.message,
      bucket: bucketName, key: dataKey
    }));
    throw err;
  }

  // ============================================================
  // Step 3: Parse JSON
  // ============================================================
  let parsed;
  try {
    console.log(JSON.stringify({
      level: 'INFO', correlationId, step: '3/4',
      message: 'Parsing order data JSON'
    }));

    parsed = JSON.parse(rawData);

    if (!parsed.orders || !Array.isArray(parsed.orders)) {
      throw new Error('Invalid schema: missing "orders" array');
    }

    console.log(JSON.stringify({
      level: 'INFO', correlationId, step: '3/4',
      message: 'JSON parse completed successfully',
      totalRecords: parsed.orders.length,
      schemaVersion: parsed.schemaVersion || 'unknown',
      elapsedMs: Date.now() - startTime
    }));
  } catch (err) {
    console.error(JSON.stringify({
      level: 'ERROR', correlationId, step: '3/4',
      message: 'JSON parse or validation failed',
      errorName: err.name, errorMessage: err.message
    }));
    throw err;
  }

  // ============================================================
  // Step 4: Transform & write to DynamoDB
  //
  // BUG: This code assumes v2 flat schema where fields like
  //   order.customerId, order.amount, order.currency, order.status
  // exist at the top level. But v3 nests them under:
  //   order.customer.id, order.pricing.amount, etc.
  //
  // This causes TypeError when accessing properties of undefined.
  // ============================================================
  let successCount = 0;
  const errors = [];

  for (const order of parsed.orders) {
    try {
      console.log(JSON.stringify({
        level: 'INFO', correlationId, step: '4/4',
        message: 'Transforming and writing order to DynamoDB',
        orderId: order.orderId, tableName
      }));

      // --- v2 schema assumptions (BROKEN for v3) ---
      const customerId = order.customerId;           // v3: order.customer.id
      const amount = order.amount;                    // v3: order.pricing.amount
      const currency = order.currency;                // v3: order.pricing.currency
      const status = order.status;                    // v3: order.fulfillment.status
      const itemCount = order.items;                  // v3: order.fulfillment.items

      // This line crashes: amount.toFixed() on undefined
      const formattedAmount = amount.toFixed(2);

      // This would also fail but we never reach here
      const customerKey = `CUSTOMER#${customerId.toUpperCase()}`;

      await dynamoClient.send(new PutItemCommand({
        TableName: tableName,
        Item: {
          PK: { S: `ORDER#${order.orderId}` },
          SK: { S: customerKey },
          orderId: { S: order.orderId },
          customerId: { S: customerId },
          amount: { N: formattedAmount },
          currency: { S: currency },
          status: { S: status },
          itemCount: { N: String(itemCount) },
          processedAt: { S: new Date().toISOString() },
          correlationId: { S: correlationId }
        }
      }));

      successCount++;
      console.log(JSON.stringify({
        level: 'INFO', correlationId, step: '4/4',
        message: 'Order written to DynamoDB successfully',
        orderId: order.orderId
      }));
    } catch (err) {
      errors.push({
        orderId: order.orderId,
        errorName: err.name,
        errorMessage: err.message
      });

      console.error(JSON.stringify({
        level: 'ERROR', correlationId, step: '4/4',
        message: 'Failed to transform/write order',
        orderId: order.orderId,
        errorName: err.name,
        errorMessage: err.message,
        tableName,
        elapsedMs: Date.now() - startTime
      }));
    }
  }

  // ============================================================
  // Final summary
  // ============================================================
  const totalElapsed = Date.now() - startTime;

  if (errors.length > 0) {
    console.error(JSON.stringify({
      level: 'ERROR', correlationId,
      message: 'Pipeline completed with failures',
      summary: {
        totalOrders: parsed.orders.length,
        successfulWrites: successCount,
        failedWrites: errors.length,
        failureRate: `${((errors.length / parsed.orders.length) * 100).toFixed(1)}%`,
        errors
      },
      totalElapsedMs: totalElapsed
    }));

    throw new Error(
      `Data pipeline failed: ${errors.length}/${parsed.orders.length} orders failed. ` +
      `First error: [${errors[0].errorName}] ${errors[0].errorMessage}. ` +
      `CorrelationId: ${correlationId}`
    );
  }

  return { statusCode: 200, body: `Processed ${parsed.orders.length} orders` };
};
