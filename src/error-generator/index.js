// Error Generator Lambda Function
// This Lambda function intentionally fails by attempting to publish to an SNS topic
// without the necessary IAM permissions. This failure triggers a CloudWatch Alarm
// which then invokes the WebHook Executor Lambda to notify AWS DevOps Agent.

const { SNSClient, PublishCommand } = require("@aws-sdk/client-sns");

exports.handler = async (event) => {
  console.log("Error Generator Lambda invoked");
  
  // Initialize SNS client using AWS SDK v3
  const snsClient = new SNSClient();
  
  // Read SNS Topic ARN from environment variable
  const topicArn = process.env.SNS_TOPIC_ARN;
  
  if (!topicArn) {
    throw new Error("SNS_TOPIC_ARN environment variable is not set");
  }
  
  console.log(`Attempting to publish to SNS topic: ${topicArn}`);
  
  // Attempt to publish a message to the SNS topic
  // This will fail because the Lambda's IAM role intentionally lacks SNS publish permissions
  // The failure is by design to demonstrate CloudWatch Alarm triggering
  const command = new PublishCommand({
    TopicArn: topicArn,
    Message: "This message will fail due to missing IAM permissions"
  });
  
  // This call will throw an AccessDenied error, causing the Lambda to fail
  // and increment the CloudWatch Errors metric
  await snsClient.send(command);
  
  // This line will never be reached due to the intentional permission error above
  return {
    statusCode: 200,
    body: "Message published successfully"
  };
}
