// OOM Error Generator Lambda Function
// Simulates a realistic out-of-memory failure during large data processing.
//
// Scenario: A batch analytics Lambda reads order history from S3 and attempts
// to build an in-memory aggregation index. The dataset has grown beyond what
// the Lambda's 128MB memory allocation can handle, causing an OOM kill.
//
// Pipeline: S3 GetObject → Decompress → Build In-Memory Index (OOM here)
//
// The S3 read succeeds, but the in-memory aggregation accumulates too much data
// and the Lambda process is killed by the runtime with "Runtime.ExitError".

const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');

const s3Client = new S3Client();

const generateCorrelationId = () =>
  `analytics-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;

// Generate a large dataset (~2MB JSON) that will balloon in memory during processing
function generateLargeDataset(recordCount) {
  const records = [];
  for (let i = 0; i < recordCount; i++) {
    records.push({
      transactionId: `TXN-${String(i).padStart(8, '0')}`,
      orderId: `ORD-${String(Math.floor(i / 10)).padStart(6, '0')}`,
      customerId: `CUST-${String(Math.floor(Math.random() * 5000)).padStart(5, '0')}`,
      product: {
        sku: `SKU-${String(Math.floor(Math.random() * 10000)).padStart(6, '0')}`,
        name: `Product Item ${i} - Extended Description for Analytics Processing`,
        category: ['Electronics', 'Clothing', 'Food', 'Books', 'Home'][i % 5],
        tags: ['sale', 'new', 'popular', 'limited', 'seasonal'].slice(0, (i % 5) + 1)
      },
      pricing: {
        unitPrice: Math.floor(Math.random() * 50000) + 100,
        quantity: Math.floor(Math.random() * 10) + 1,
        currency: 'JPY',
        tax: Math.floor(Math.random() * 5000),
        discount: Math.floor(Math.random() * 2000)
      },
      timestamp: new Date(Date.now() - Math.floor(Math.random() * 86400000 * 30)).toISOString(),
      region: ['ap-northeast-1', 'us-east-1', 'eu-west-1'][i % 3],
      metadata: {
        source: 'batch-export',
        version: '2.0',
        processedBy: `worker-${i % 8}`
      }
    });
  }
  return {
    exportId: `EXPORT-${Date.now()}`,
    exportedAt: new Date().toISOString(),
    totalRecords: records.length,
    transactions: records
  };
}

exports.handler = async (event) => {
  const correlationId = generateCorrelationId();
  const startTime = Date.now();

  console.log(JSON.stringify({
    level: 'INFO', correlationId,
    message: 'Batch analytics pipeline started',
    trigger: event.source || 'manual',
    memoryLimitMB: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
    timestamp: new Date().toISOString()
  }));

  const bucketName = process.env.DATA_BUCKET_NAME;
  const dataKey = 'analytics/transaction-history.json';
  const RECORD_COUNT = 25000;

  // ============================================================
  // Step 1: Seed large dataset to S3
  // ============================================================
  try {
    console.log(JSON.stringify({
      level: 'INFO', correlationId, step: '1/4',
      message: 'Generating and uploading transaction dataset to S3',
      targetRecords: RECORD_COUNT,
      bucket: bucketName, key: dataKey
    }));

    const dataset = generateLargeDataset(RECORD_COUNT);
    const dataJson = JSON.stringify(dataset);
    const dataSizeMB = (Buffer.byteLength(dataJson, 'utf8') / 1024 / 1024).toFixed(2);

    await s3Client.send(new PutObjectCommand({
      Bucket: bucketName,
      Key: dataKey,
      Body: dataJson,
      ContentType: 'application/json'
    }));

    console.log(JSON.stringify({
      level: 'INFO', correlationId, step: '1/4',
      message: 'Dataset uploaded to S3 successfully',
      dataSizeMB,
      recordCount: dataset.totalRecords,
      heapUsedMB: (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2),
      elapsedMs: Date.now() - startTime
    }));
  } catch (err) {
    console.error(JSON.stringify({
      level: 'ERROR', correlationId, step: '1/4',
      message: 'Failed to upload dataset to S3',
      errorName: err.name, errorMessage: err.message
    }));
    throw err;
  }

  // ============================================================
  // Step 2: Read dataset from S3
  // ============================================================
  let rawData;
  try {
    console.log(JSON.stringify({
      level: 'INFO', correlationId, step: '2/4',
      message: 'Reading transaction dataset from S3',
      bucket: bucketName, key: dataKey
    }));

    const s3Response = await s3Client.send(new GetObjectCommand({
      Bucket: bucketName, Key: dataKey
    }));
    rawData = await s3Response.Body.transformToString();

    console.log(JSON.stringify({
      level: 'INFO', correlationId, step: '2/4',
      message: 'S3 read completed successfully',
      dataSizeMB: (Buffer.byteLength(rawData, 'utf8') / 1024 / 1024).toFixed(2),
      heapUsedMB: (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2),
      elapsedMs: Date.now() - startTime
    }));
  } catch (err) {
    console.error(JSON.stringify({
      level: 'ERROR', correlationId, step: '2/4',
      message: 'Failed to read from S3',
      errorName: err.name, errorMessage: err.message
    }));
    throw err;
  }

  // ============================================================
  // Step 3: Parse JSON
  // ============================================================
  let transactions;
  try {
    console.log(JSON.stringify({
      level: 'INFO', correlationId, step: '3/4',
      message: 'Parsing transaction data'
    }));

    const parsed = JSON.parse(rawData);
    transactions = parsed.transactions;

    console.log(JSON.stringify({
      level: 'INFO', correlationId, step: '3/4',
      message: 'Parse completed successfully',
      totalTransactions: transactions.length,
      exportId: parsed.exportId,
      heapUsedMB: (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2),
      elapsedMs: Date.now() - startTime
    }));
  } catch (err) {
    console.error(JSON.stringify({
      level: 'ERROR', correlationId, step: '3/4',
      message: 'JSON parse failed',
      errorName: err.name, errorMessage: err.message
    }));
    throw err;
  }

  // ============================================================
  // Step 4: Build in-memory aggregation index (OOM HERE)
  //
  // BUG: This code builds multiple large indexes simultaneously
  // without streaming or pagination. With 15k records, the
  // duplicated/expanded data structures exceed 128MB.
  // ============================================================
  console.log(JSON.stringify({
    level: 'INFO', correlationId, step: '4/4',
    message: 'Building in-memory aggregation indexes',
    transactionCount: transactions.length,
    heapUsedMB: (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)
  }));

  // Index 1: Group by customer with full transaction history
  const customerIndex = {};
  // Index 2: Group by product category with details
  const categoryIndex = {};
  // Index 3: Time-series bucketing with full records
  const timeSeriesIndex = {};
  // Index 4: Cross-reference matrix (customer x category)
  const crossRefMatrix = {};

  let processed = 0;

  for (const txn of transactions) {
    // Customer index: store full transaction copy per customer
    if (!customerIndex[txn.customerId]) {
      customerIndex[txn.customerId] = { transactions: [], totalSpend: 0, categories: {} };
    }
    customerIndex[txn.customerId].transactions.push({ ...txn, _enriched: true, _indexedAt: new Date().toISOString() });
    customerIndex[txn.customerId].totalSpend += txn.pricing.unitPrice * txn.pricing.quantity;

    // Category index: store full transaction copy per category
    const cat = txn.product.category;
    if (!categoryIndex[cat]) {
      categoryIndex[cat] = { transactions: [], revenue: 0, uniqueCustomers: new Set() };
    }
    categoryIndex[cat].transactions.push({ ...txn, _categoryEnriched: true, _tags: [...txn.product.tags] });
    categoryIndex[cat].revenue += txn.pricing.unitPrice * txn.pricing.quantity;
    categoryIndex[cat].uniqueCustomers.add(txn.customerId);

    // Time-series: bucket by hour with full records
    const hourBucket = txn.timestamp.substring(0, 13);
    if (!timeSeriesIndex[hourBucket]) {
      timeSeriesIndex[hourBucket] = [];
    }
    timeSeriesIndex[hourBucket].push({ ...txn, _timeBucket: hourBucket, _processed: true });

    // Cross-reference: customer x category with duplicated data
    const crossKey = `${txn.customerId}::${cat}`;
    if (!crossRefMatrix[crossKey]) {
      crossRefMatrix[crossKey] = { items: [], summary: {} };
    }
    crossRefMatrix[crossKey].items.push({
      ...txn,
      _crossRef: crossKey,
      _computedTotal: txn.pricing.unitPrice * txn.pricing.quantity - txn.pricing.discount + txn.pricing.tax,
      _duplicateForAnalysis: JSON.parse(JSON.stringify(txn))
    });

    processed++;

    if (processed % 3000 === 0) {
      const mem = process.memoryUsage();
      console.log(JSON.stringify({
        level: 'WARN', correlationId, step: '4/4',
        message: 'Aggregation progress - memory increasing',
        processedRecords: processed,
        totalRecords: transactions.length,
        progressPercent: ((processed / transactions.length) * 100).toFixed(1),
        heapUsedMB: (mem.heapUsed / 1024 / 1024).toFixed(2),
        heapTotalMB: (mem.heapTotal / 1024 / 1024).toFixed(2),
        rssMB: (mem.rss / 1024 / 1024).toFixed(2),
        elapsedMs: Date.now() - startTime
      }));
    }
  }

  // This line is unlikely to be reached with 128MB memory
  console.log(JSON.stringify({
    level: 'INFO', correlationId, step: '4/4',
    message: 'Aggregation completed',
    uniqueCustomers: Object.keys(customerIndex).length,
    categories: Object.keys(categoryIndex).length,
    timeBuckets: Object.keys(timeSeriesIndex).length,
    crossRefEntries: Object.keys(crossRefMatrix).length
  }));

  return { statusCode: 200, body: `Processed ${processed} transactions` };
};
