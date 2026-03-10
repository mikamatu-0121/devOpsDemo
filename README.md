# AWS DevOps Agent CloudWatch WebHook Tutorial

## Overview

This tutorial demonstrates how to automatically trigger AWS DevOps Agent investigations via WebHook when a CloudWatch Alarm enters the ALARM state. The implementation uses a serverless architecture built with AWS SAM (Serverless Application Model), featuring two Lambda functions, a CloudWatch Alarm, and an SNS topic.

**What you'll build:**
- An Error Generator Lambda function that intentionally fails to trigger alarms
- A CloudWatch Alarm that monitors Lambda errors
- A WebHook Executor Lambda that calls AWS DevOps Agent when alarms fire
- Complete infrastructure-as-code using AWS SAM

**Use cases:**
- Automatic incident investigation when production errors occur
- Integration of CloudWatch monitoring with DevOps Agent workflows
- Serverless event-driven automation patterns

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Tutorial User                            │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         │ 1. Invoke
                         ▼
              ┌──────────────────────┐
              │ Error Generator      │
              │ Lambda               │
              │ (Node.js 24.x)       │
              └──────────┬───────────┘
                         │
                         │ 2. Attempt SNS Publish
                         │    (Fails - No Permission)
                         ▼
              ┌──────────────────────┐
              │ SNS Topic            │
              │ (Target)             │
              └──────────────────────┘
                         │
                         │ 3. Error Metric
                         ▼
              ┌──────────────────────┐
              │ CloudWatch Alarm     │
              │ (Monitors Errors)    │
              └──────────┬───────────┘
                         │
                         │ 4. AlarmActions (Direct Invoke)
                         ▼
              ┌──────────────────────┐
              │ WebHook Executor     │
              │ Lambda               │
              │ (Node.js 24.x)       │
              └──────────┬───────────┘
                         │
                         │ 5. HTTP POST
                         │    (HMAC signature)
                         ▼
              ┌──────────────────────┐
              │ AWS DevOps Agent     │
              │ WebHook Endpoint     │
              └──────────────────────┘
```

**How it works:**

1. You manually invoke the Error Generator Lambda function
2. The Lambda attempts to publish to an SNS topic but fails due to missing permissions
3. The failure generates an error metric in CloudWatch
4. The CloudWatch Alarm detects the error and transitions to ALARM state
5. The alarm directly invokes the WebHook Executor Lambda
6. The WebHook Executor sends an authenticated HTTP POST request to DevOps Agent
7. DevOps Agent receives the incident and starts an investigation


## Prerequisites

Before you begin, ensure you have the following:

### Required Tools

1. **AWS CLI** - Command line interface for AWS services
   - Installation: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html
   - Verify installation: `aws --version`
   - Configure credentials: `aws configure`

2. **AWS SAM CLI** - Tool for building and deploying serverless applications
   - Installation: https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html
   - Verify installation: `sam --version`
   - Minimum version: 1.0.0

3. **AWS Account** - Active AWS account with appropriate permissions
   - Permissions needed: Lambda, CloudWatch, SNS, IAM, CloudFormation

### AWS DevOps Agent Setup

Before deploying this tutorial, you need to create a DevOps Agent Space and store WebHook credentials in AWS Secrets Manager:

#### Step 1: Create a DevOps Agent Space

1. Navigate to the AWS DevOps Agent console
2. Click "Create Space" or select an existing space
3. Configure your space settings (name, description, etc.)
4. Note your Space ID for reference

#### Step 2: Obtain WebHook Credentials

1. In your DevOps Agent Space, navigate to "Settings" or "Integrations"
2. Find the "WebHook" section
3. Click "Create WebHook" or "Generate Credentials"
4. Copy the following values:
   - **WebHook URL**: The HTTPS endpoint for your space (e.g., `https://devops-agent.amazonaws.com/webhooks/your-space-id`)
   - **WebHook Secret**: The authentication token/API key for signing requests

#### Step 3: Store Credentials in AWS Secrets Manager

Store your WebHook credentials securely in AWS Secrets Manager:

```bash
# Set your WebHook credentials as environment variables
export WEBHOOK_URL="https://devops-agent.amazonaws.com/webhooks/your-space-id"
export WEBHOOK_SECRET="your-webhook-secret-here"
export SECRET_NAME="devops-agent-webhook-credentials"

# Create the secret in Secrets Manager with JSON format
aws secretsmanager create-secret \
  --name ${SECRET_NAME} \
  --description "DevOps Agent WebHook credentials" \
  --secret-string "{\"webhookUrl\":\"${WEBHOOK_URL}\",\"webhookSecret\":\"${WEBHOOK_SECRET}\"}"
```

**Expected output:**
```json
{
    "ARN": "arn:aws:secretsmanager:us-east-1:123456789012:secret:devops-agent-webhook-credentials-AbCdEf",
    "Name": "devops-agent-webhook-credentials",
    "VersionId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
}
```

**Important:** Keep your WebHook Secret secure. The secret is now stored in Secrets Manager and will not be exposed in CloudFormation parameters or environment variables.


## Deployment

Follow these steps to deploy the tutorial infrastructure to your AWS account.

### Step 1: Clone or Download the Tutorial

```bash
# If using git
git clone https://github.com/aws-samples/sample-aws-devops-agent-cloudwatch.git
cd sample-aws-devops-agent-cloudwatch

# Or download and extract the tutorial files
```

### Step 2: Build the SAM Application

The `sam build` command prepares your application for deployment by installing dependencies and packaging your Lambda functions.

```bash
sam build
```

**Expected output:**
```
Building codeuri: src/error-generator runtime: nodejs24.x ...
Building codeuri: src/webhook-executor runtime: nodejs24.x ...
Build Succeeded
```

### Step 3: Deploy the SAM Application

Deploy the application using the `sam deploy` command with the Secrets Manager secret name as a parameter.

#### Option A: Guided Deployment (Recommended for First Time)

```bash
sam deploy --guided
```

You'll be prompted for:
- **Stack Name**: Enter a name (e.g., `devops-agent-webhook-tutorial`)
- **AWS Region**: Choose your preferred region (e.g., `us-east-1`)
- **Parameter SecretArn**: Enter your secret ARN (from the `create-secret` output above)
- **Confirm changes before deploy**: Y
- **Allow SAM CLI IAM role creation**: Y
- **Save arguments to configuration file**: Y

#### Option B: Direct Deployment with Parameters

If you've already run guided deployment or want to deploy directly:

```bash
sam deploy \
  --stack-name devops-agent-webhook-tutorial \
  --parameter-overrides \
    SecretArn=arn:aws:secretsmanager:us-east-1:123456789012:secret:devops-agent-webhook-credentials-AbCdEf \
  --capabilities CAPABILITY_IAM \
  --resolve-s3
```

**Parameter explanations:**
- `--stack-name`: CloudFormation stack name for your deployment
- `--parameter-overrides`: Passes the Secrets Manager secret ARN to the template
- `--capabilities CAPABILITY_IAM`: Allows SAM to create IAM roles
- `--resolve-s3`: Automatically creates/uses an S3 bucket for deployment artifacts

## Testing and Verification

Now that your infrastructure is deployed, let's test the end-to-end flow.

### Step 1: Invoke the Error Generator Lambda

Trigger the Error Generator Lambda to intentionally cause a failure:

```bash
# Get the function name from your stack
FUNCTION_NAME=$(aws cloudformation describe-stack-resources \
  --stack-name devops-agent-webhook-tutorial \
  --query "StackResources[?LogicalResourceId=='ErrorGeneratorFunction'].PhysicalResourceId" \
  --output text)

# Invoke the function
aws lambda invoke \
  --function-name $FUNCTION_NAME \
  --payload '{}' \
  response.json

# View the response
cat response.json
```

**Expected result:**
- The Lambda invocation will fail with an error
- You'll see an error message about missing SNS permissions
- This is intentional and expected behavior

### Step 2: Check CloudWatch Alarm State

Wait 1-2 minutes for the alarm to evaluate, then check its state. Since the alarm name is auto-generated by CloudFormation, retrieve it from the stack outputs:

```bash
# Get the alarm name from the stack outputs
ALARM_NAME=$(aws cloudformation describe-stacks \
  --stack-name devops-agent-webhook-tutorial \
  --query "Stacks[0].Outputs[?OutputKey=='LambdaErrorAlarmName'].OutputValue" \
  --output text)

# Check alarm state
aws cloudwatch describe-alarms \
  --alarm-names "$ALARM_NAME" \
  --query "MetricAlarms[].[AlarmName,StateValue,StateReason]" \
  --output table
```

**Expected output:**
```
-----------------------------------------------------------------
|                        DescribeAlarms                         |
+---------------------------------------+---------+-------------+
|  devops-agent-webhook-tutorial-...    |  ALARM  | Threshold...|
+---------------------------------------+---------+-------------+
```

The alarm should transition from `OK` or `INSUFFICIENT_DATA` to `ALARM` state.

### Step 3: Verify WebHook Executor Invocation

Check the WebHook Executor Lambda logs to confirm it was triggered:

```bash
# Get the WebHook Executor function name
WEBHOOK_FUNCTION_NAME=$(aws cloudformation describe-stack-resources \
  --stack-name devops-agent-webhook-tutorial \
  --query "StackResources[?LogicalResourceId=='WebHookExecutorFunction'].PhysicalResourceId" \
  --output text)

# View recent logs
aws logs tail /aws/lambda/$WEBHOOK_FUNCTION_NAME --follow
```

**What to look for:**
- Log entries showing "Sending webhook request"
- HTTP response status (should be 200 or 202)
- No error messages about authentication or network failures

### Step 4: Confirm Investigation in DevOps Agent

1. Open DevOps Agent web app
2. You should see a new investigation with:
   - Title matching your CloudWatch Alarm name
   - Description containing alarm details
   - Status showing the investigation is in progress

## Cleanup

When you're done with the tutorial, remove all deployed resources to avoid ongoing charges.

### Step 1: Delete the SAM Stack

```bash
sam delete --stack-name devops-agent-webhook-tutorial
```

You'll be prompted to confirm deletion. Type `y` to proceed.

**Alternative method using AWS CLI:**

```bash
aws cloudformation delete-stack --stack-name devops-agent-webhook-tutorial

# Wait for deletion to complete
aws cloudformation wait stack-delete-complete --stack-name devops-agent-webhook-tutorial
```

### Step 2: Delete the Secrets Manager Secret

Remove the WebHook credentials from Secrets Manager:

```bash
# Set your secret name
export SECRET_NAME="devops-agent-webhook-credentials"

# Delete the secret (with recovery window)
aws secretsmanager delete-secret \
  --secret-id ${SECRET_NAME} \
  --recovery-window-in-days 7
```

**Note:** By default, secrets are scheduled for deletion with a 7-day recovery window. To delete immediately without recovery:

```bash
aws secretsmanager delete-secret \
  --secret-id ${SECRET_NAME} \
  --force-delete-without-recovery
```

### Step 3: Verify Cleanup

Confirm all resources have been deleted:

```bash
# Check if stack still exists
aws cloudformation describe-stacks --stack-name devops-agent-webhook-tutorial
```

**Expected result:** Error message indicating the stack doesn't exist.

**Verify secret deletion:**

```bash
aws secretsmanager describe-secret --secret-id ${SECRET_NAME}
```

**Expected result:** Error message indicating the secret is scheduled for deletion or doesn't exist.

### Manual Cleanup (if needed)

If automatic deletion fails, you may need to manually delete:

1. **Lambda functions**: Check AWS Lambda console
2. **CloudWatch Alarms**: Check CloudWatch console
3. **SNS Topics**: Check SNS console
4. **CloudWatch Log Groups**: These are retained by default
   ```bash
   aws logs delete-log-group --log-group-name /aws/lambda/devops-agent-webhook-tutorial-ErrorGeneratorFunction-*
   aws logs delete-log-group --log-group-name /aws/lambda/devops-agent-webhook-tutorial-WebHookExecutorFunction-*
   ```

5. **Secrets Manager secret**: Delete the secret if no longer needed
   ```bash
   aws secretsmanager delete-secret --secret-id devops-agent-webhook-credentials --force-delete-without-recovery
   ```
