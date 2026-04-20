// DynamoDB Permission Error Generator Lambda Function
// Pipeline: S3 Read → Parse → Transform → DynamoDB Write (fails - no permission)

const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { DynamoDBClient, PutItemCommand } = require('@aws-sdk/client-dynamodb');

const s3Client = new S3Client();
const dynamoClient = new DynamoDBClient();

const generateCorrelationId = () =>
  `pipeline-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;

const ORDER_DATA = {
  orders: [
    { orderId: 'ORD-20260415-001', customerId: 'CUST-1042', amount: 15800, currency: 'JPY', status: 'confirmed', items: 3, region: 'ap-northeast-1' },
    { orderId: 'ORD-20260415-002', customerId: 'CUST-2087', amount: 4200, currency: 'JPY', status: 'confirmed', items: 1, region: 'ap-northeast-1' },
    { orderId: 'ORD-20260415-003', customerId: 'CUST-0553', amount: 32400, currency: 'JPY', status: 'pending_payment', items: 5, region: 'ap-northeast-1' }
  ],
  exportedAt: new Date().toISOString(),
  version: '2.1.0'
};

exports.handler = async (event) => {
  const correlationId = generateCorrelationId();
  const startTime = Date.now();

  console.log(JSON.stringify({
    level: 'INFO', correlationId,
    message: 'Order sync pipeline started',
    trigger: event.source || 'manual',
    timestamp: new Date().toISOString()
  }));

  const bucketName = process.env.DATA_BUCKET_NAME;
  const tableName = process.env.TABLE_NAME;
  const dataKey = 'sync/order-data.json';

  // Step 1: Upload data to S3
  try {
    console.log(JSON.stringify({ level: 'INFO', correlationId, step: '1/4', message: 'Uploading order data to S3', bucket: bucketName, key: dataKey }));
    await s3Client.send(new PutObjectCommand({ Bucket: bucketName, Key: dataKey, Body: JSON.stringify(ORDER_DATA), ContentType: 'application/json' }));
    console.log(JSON.stringify({ level: 'INFO', correlationId, step: '1/4', message: 'Upload successful', elapsedMs: Date.now() - startTime }));
  } catch (err) {
    console.error(JSON.stringify({ level: 'ERROR', correlationId, step: '1/4', message: 'S3 upload failed', errorName: err.name, errorMessage: err.message }));
    throw err;
  }

  // Step 2: Read data from S3
  let rawData;
  try {
    console.log(JSON.stringify({ level: 'INFO', correlationId, step: '2/4', message: 'Reading order data from S3', bucket: bucketName, key: dataKey }));
    const s3Response = await s3Client.send(new GetObjectCommand({ Bucket: bucketName, Key: dataKey }));
    rawData = await s3Response.Body.transformToString();
    console.log(JSON.stringify({ level: 'INFO', correlationId, step: '2/4', message: 'S3 read successful', fileSizeKB: (Buffer.byteLength(rawData, 'utf8') / 1024).toFixed(2), elapsedMs: Date.now() - startTime }));
  } catch (err) {
    console.error(JSON.stringify({ level: 'ERROR', correlationId, step: '2/4', message: 'S3 read failed', errorName: err.name, errorMessage: err.message }));
    throw err;
  }

  // Step 3: Parse and transform
  let orders;
  try {
    console.log(JSON.stringify({ level: 'INFO', correlationId, step: '3/4', message: 'Parsing and transforming order data' }));
    const parsed = JSON.parse(rawData);
    orders = parsed.orders.map(order => ({
      PK: { S: `ORDER#${order.orderId}` },
      SK: { S: `CUSTOMER#${order.customerId}` },
      orderId: { S: order.orderId },
      customerId: { S: order.customerId },
      amount: { N: String(order.amount) },
      currency: { S: order.currency },
      status: { S: order.status },
      itemCount: { N: String(order.items) },
      region: { S: order.region },
      processedAt: { S: new Date().toISOString() },
      correlationId: { S: correlationId }
    }));
    console.log(JSON.stringify({ level: 'INFO', correlationId, step: '3/4', message: 'Transform successful', recordCount: orders.length, elapsedMs: Date.now() - startTime }));
  } catch (err) {
    console.error(JSON.stringify({ level: 'ERROR', correlationId, step: '3/4', message: 'Parse/transform failed', errorName: err.name, errorMessage: err.message }));
    throw err;
  }

  // Step 4: Write to DynamoDB (FAILS - no dynamodb:PutItem permission)
  let successCount = 0;
  const errors = [];

  for (const item of orders) {
    const orderId = item.orderId.S;
    try {
      console.log(JSON.stringify({ level: 'INFO', correlationId, step: '4/4', message: 'Writing order to DynamoDB', orderId, tableName }));
      await dynamoClient.send(new PutItemCommand({ TableName: tableName, Item: item }));
      successCount++;
    } catch (err) {
      errors.push({ orderId, errorName: err.name, errorMessage: err.message });
      console.error(JSON.stringify({ level: 'ERROR', correlationId, step: '4/4', message: 'DynamoDB write failed', orderId, errorName: err.name, errorMessage: err.message, tableName, elapsedMs: Date.now() - startTime }));
    }
  }

  if (errors.length > 0) {
    console.error(JSON.stringify({
      level: 'ERROR', correlationId,
      message: 'Pipeline completed with failures',
      summary: { totalOrders: orders.length, successfulWrites: successCount, failedWrites: errors.length, failureRate: `${((errors.length / orders.length) * 100).toFixed(1)}%`, errors },
      totalElapsedMs: Date.now() - startTime
    }));
    throw new Error(`Order sync pipeline failed: ${errors.length}/${orders.length} DynamoDB writes failed. First error: [${errors[0].errorName}] ${errors[0].errorMessage}. CorrelationId: ${correlationId}`);
  }

  return { statusCode: 200, body: `Synced ${orders.length} orders` };
};
