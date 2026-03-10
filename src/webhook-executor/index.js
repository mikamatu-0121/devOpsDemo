// WebHook Executor Lambda Function
// This Lambda function is triggered by CloudWatch Alarms and sends HTTP POST requests
// to the AWS DevOps Agent WebHook endpoint with HMAC-SHA256 authentication.

const crypto = require('crypto');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

exports.handler = async (event) => {
  console.log("WebHook Executor Lambda invoked");
  console.log("CloudWatch Alarm event:", JSON.stringify(event, null, 2));
  
  // Retrieve WebHook credentials from Secrets Manager
  const secretArn = process.env.SECRET_ARN;
  if (!secretArn) {
    throw new Error("SECRET_ARN environment variable is not set");
  }
  
  const secretsClient = new SecretsManagerClient();
  const getSecretCommand = new GetSecretValueCommand({ SecretId: secretArn });
  
  let webhookUrl, webhookSecret;
  try {
    const secretResponse = await secretsClient.send(getSecretCommand);
    const secretData = JSON.parse(secretResponse.SecretString);
    webhookUrl = secretData.webhookUrl;
    webhookSecret = secretData.webhookSecret;
    
    if (!webhookUrl || !webhookSecret) {
      throw new Error("webhookUrl and webhookSecret must be present in the secret");
    }
    
    console.log("Successfully retrieved credentials from Secrets Manager");
  } catch (error) {
    console.error("Failed to retrieve secret from Secrets Manager:", error);
    throw error;
  }
  
  // Extract alarm details from CloudWatch Alarm event
  // When CloudWatch Alarm directly invokes Lambda, the event structure is different
  // from SNS-based notifications. The alarm data is nested under event.alarmData
  const alarmData = {
    alarmName: event.alarmData?.alarmName || 'Unknown',
    state: event.alarmData?.state?.value || 'ALARM',
    reason: event.alarmData?.state?.reason || 'No reason provided',
    timestamp: event.time || new Date().toISOString(),
    region: event.region || process.env.AWS_REGION || 'us-east-1',
    alarmArn: event.alarmArn || 'Unknown'
  };
  
  // Extract namespace from alarm configuration metrics
  // This is used as the service name in the webhook payload
  let namespace = 'AWS';
  if (event.alarmData?.configuration?.metrics && event.alarmData.configuration.metrics.length > 0) {
    const metric = event.alarmData.configuration.metrics[0];
    namespace = metric.metricStat?.metric?.namespace || 'AWS';
  }
  
  // Read WebHook configuration from environment variables
  const timestamp = new Date().toISOString();
  
  // Prepare WebHook request payload according to DevOps Agent WebHook API specification
  const payload = {
    eventType: 'incident',
    incidentId: `alarm-${alarmData.alarmName}-${Math.floor(Date.now() / 1000)}`,
    action: 'created',
    priority: alarmData.state === 'ALARM' ? 'HIGH' : 'MEDIUM',
    title: alarmData.alarmName,
    description: `CloudWatch Alarm "${alarmData.alarmName}" has entered ${alarmData.state} state.\n\nReason: ${alarmData.reason}\nAlarm ARN: ${alarmData.alarmArn}\nRegion: ${alarmData.region}`,
    service: namespace,
    timestamp: timestamp,
    data: {
      metadata: {
        alarm_name: alarmData.alarmName,
        alarm_arn: alarmData.alarmArn,
        region: alarmData.region,
        state: alarmData.state,
        reason: alarmData.reason
      }
    }
  };
  
  const payloadJson = JSON.stringify(payload);
  
  // Generate HMAC-SHA256 signature
  // Format: timestamp:payload
  const signatureInput = `${timestamp}:${payloadJson}`;
  const hmac = crypto.createHmac('sha256', webhookSecret);
  hmac.update(signatureInput, 'utf8');
  const signature = hmac.digest('base64');
  
  // Prepare HTTP headers with HMAC authentication
  const headers = {
    'Content-Type': 'application/json',
    'x-amzn-event-signature': signature,
    'x-amzn-event-timestamp': timestamp
  };
  
  // Log request details (excluding sensitive data)
  console.log('Sending webhook request:', {
    url: webhookUrl,
    headers: {
      'Content-Type': headers['Content-Type'],
      'x-amzn-event-timestamp': headers['x-amzn-event-timestamp']
    },
    payloadSize: payloadJson.length
  });
  
  try {
    // Send HTTP POST request to DevOps Agent WebHook endpoint
    // Using fetch API (available in Node.js 18+)
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: headers,
      body: payloadJson
    });
    
    const responseBody = await response.text();
    
    // Log response details
    console.log('WebHook response:', {
      statusCode: response.status,
      statusText: response.statusText,
      body: responseBody
    });
    
    // Check if request was successful
    if (response.ok) {
      console.log('WebHook invoked successfully');
      return {
        statusCode: 200,
        body: 'WebHook invoked successfully'
      };
    } else {
      console.error('WebHook request failed with non-2xx status:', response.status);
      return {
        statusCode: response.status,
        body: `WebHook request failed: ${response.statusText}`
      };
    }
    
  } catch (error) {
    // Handle network errors, timeouts, and other exceptions
    console.error('WebHook request failed:', error);
    throw error;
  }
};
