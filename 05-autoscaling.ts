// Pulumi has two different AWS provider which we'll use in this code sample:
// 1. Native AWS provider: This provider is built on top of AWS's Cloud Control API and provides a more
// 2. Classic AWS provider: This provider is built on top of AWS's SDK and provides a more comprehensive set of resources and properties.
// 
// → Some resources are not yet available in the Native AWS provider, so we are using both providers in this example.

import * as pulumi from "@pulumi/pulumi";
import * as awsClassic from "@pulumi/aws";
import * as awsnative from "@pulumi/aws-native";
import * as awsx from "@pulumi/awsx"

/**
 * Classic AWS provider stuff
 */

// VPC = Virtual Private Cloud
// Subnet = A range of IP addresses in your VPC
const defaultVpc = awsClassic.ec2.getVpcOutput({ default: true });
const defaultVpcSubnets = awsClassic.ec2.getSubnetsOutput({
    filters: [
        { name: "vpc-id", values: [defaultVpc.id] },
    ],
});

// Security Group = A virtual firewall that controls inbound and outbound traffic to your instances
const group = new awsClassic.ec2.SecurityGroup("web-secgrp", {
    vpcId: defaultVpc.id,
    description: "Enable HTTP & HTTPs access",
    ingress: [
        {
            protocol: "tcp",
            fromPort: 80,
            toPort: 80,
            cidrBlocks: ["0.0.0.0/0"],
        },
        {
            protocol: "tcp",
            fromPort: 443,
            toPort: 443,
            cidrBlocks: ["0.0.0.0/0"],
        },
    ],
    egress: [{
        protocol: "-1",
        fromPort: 0,
        toPort: 0,
        cidrBlocks: ["0.0.0.0/0"],
    }],
});

// ALB = Application Load Balancer (can route based on path (e.g. /api, /billing etc.))
const alb = new awsClassic.lb.LoadBalancer("app-lb", {
    securityGroups: [group.id],
    subnets: defaultVpcSubnets.ids,
});

// Target Group = For a VM (=EC2 instance) on AWS, to be reachable by a load balancer, it must be registered with a target group
const todoAppTg = new awsClassic.lb.TargetGroup("todo-app-tg", {
    port: 80,
    protocol: "HTTP",
    targetType: "ip",
    vpcId: defaultVpc.id,
});

const todoApiTg = new awsClassic.lb.TargetGroup("todo-api-tg", {
    port: 80,
    protocol: "HTTP",
    targetType: "ip",
    vpcId: defaultVpc.id,
    healthCheck: {
        path: '/api/',
        interval: 5,
        timeout: 2,
    }
});

// The role that the ECS tasks will receive once it's running
const ecsTaskInitializationRole = new awsClassic.iam.Role("task-init-role", {
    assumeRolePolicy: {
        Version: "2008-10-17",
        Statement: [{
            Sid: "",
            Effect: "Allow",
            Principal: {
                Service: "ecs-tasks.amazonaws.com",
            },
            Action: "sts:AssumeRole",
        }],
    },
});

// Here we simply attach the AmazonECSTaskExecutionRolePolicy policy to the role (= a predefined set of permissions)
// See details here: https://docs.aws.amazon.com/aws-managed-policy/latest/reference/AmazonECSTaskExecutionRolePolicy.html
const rpa = new awsClassic.iam.RolePolicyAttachment("task-exec-policy", {
    role: ecsTaskInitializationRole.name,
    policyArn: "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy",
});

/**
 * Native AWS provider stuff
 */
// Cluster -[has multiple]→ Services -[has multiple]→ Tasks -[has 1-x]→ Containers
const cluster = new awsnative.ecs.Cluster("aws-by-example");

const httpsRedirectListener = new awsnative.elasticloadbalancingv2.Listener("https-redirect-listener", {
    loadBalancerArn: alb.arn,
    port: 80,
    protocol: "HTTP",
    defaultActions: [{
        type: 'redirect',
        redirectConfig: {
            statusCode: 'HTTP_301',
            host: '#{host}',
            path: '/#{path}',
            protocol: 'HTTPS',
        }
    }],
});

const YOUR_DOMAIN = 'uncld.net'


const certificate = new awsClassic.acm.Certificate("alb-certificate", {
    domainName: YOUR_DOMAIN,
    validationMethod: "DNS",
})

const hostedZone = awsClassic.route53.getZone({
    name: YOUR_DOMAIN,
    privateZone: false,
})

// Code stolen here: https://ahanoff.dev/blog/worry-free-aws-acm-cert-validation/
const hostedZoneAlbRecord = new awsClassic.route53.Record("lb-alias-record", {
    name: YOUR_DOMAIN, // One of the few examples where setting the explicit naming property (disabling Pulumi auto-naming) is actually useful
    zoneId: hostedZone.then(hostedZone => hostedZone.id),
    type: awsClassic.route53.RecordType.A,
    aliases: [{
        name: alb.dnsName,
        zoneId: alb.zoneId,
        evaluateTargetHealth: true,
    }]
})

/**
 * https://github.com/you-dont-need/You-Dont-Need-Lodash-Underscore#_uniqWith
 * @param arr sequence of elements that are not unique
 * @param fn comparator
 * @returns 
 */
const uniqWith = (arr: any[], fn: (arg0: any, arg1: any) => any) => arr.filter((element, index) => arr.findIndex((step) => fn(element, step)) === index);

certificate.domainValidationOptions.apply(validationOptions => {
    // filter out duplicate validation options based on record type, name and value
    uniqWith(validationOptions, (x: awsClassic.types.output.acm.CertificateDomainValidationOption, y: awsClassic.types.output.acm.CertificateDomainValidationOption) => {
        return x.resourceRecordType === y.resourceRecordType && x.resourceRecordValue === y.resourceRecordValue && x.resourceRecordName === y.resourceRecordName
    })
        // map validation options to Route53 record
        .map((validationOption, index) => {
            return new awsClassic.route53.Record(`${YOUR_DOMAIN}-cert-validation-record-${index}`, {
                type: validationOption.resourceRecordType,
                ttl: 60,
                zoneId: hostedZone.then(hostedZone => hostedZone.id),
                name: validationOption.resourceRecordName,
                records: [
                    validationOption.resourceRecordValue
                ]
            })
        })
        // for each record request DSN validation
        .forEach((certValidationRecord, index) => {
            new awsClassic.acm.CertificateValidation(`${YOUR_DOMAIN}-cert-dns-validation-${index}`, {
                certificateArn: certificate.arn,
                validationRecordFqdns: [certValidationRecord.fqdn]
            })
        })
})

const todoListener = new awsnative.elasticloadbalancingv2.Listener("todo-listener", {
    loadBalancerArn: alb.arn,
    certificates: [{
        certificateArn: certificate.arn,
    }],
    port: 443,
    protocol: "HTTPS",
    defaultActions: [{
        type: "forward",
        targetGroupArn: todoAppTg.arn,
    }],
});

const todoApiListenerRule = new awsClassic.lb.ListenerRule("api-rule", {
    listenerArn: todoListener.listenerArn,
    actions: [{
        type: "forward",
        targetGroupArn: todoApiTg.arn,
    }],
    conditions: [{
        pathPattern: {
            values: ["/api/*"], // For any path starting with /api
        },
    }],
    priority: 10,
});

// Now, let's setup our own website as the image we're using
const ecrRepo = new awsClassic.ecr.Repository("abe-example-repo", {
    imageTagMutability: "MUTABLE",
    imageScanningConfiguration: {
        scanOnPush: true,
    },
});

// For our AWS examples, we like to avoid using Pulumi Crosswalk (=components that implement architectural best-practises) to *actually*
// understand how to build everything by hand, *however* the awsx.ecr.Image construct is a really elegant piece of tech that makes our lifes far simpler :)
const todoAppImage = new awsx.ecr.Image("todo-app-image", {
    repositoryUrl: ecrRepo.repositoryUrl,
    context: "./todo-app",
    dockerfile: "./todo-app/Dockerfile",
    platform: 'linux/arm64',
});

const todoApiImage = new awsx.ecr.Image("todo-api-image", {
    repositoryUrl: ecrRepo.repositoryUrl,
    context: "./todo-api",
    dockerfile: "./todo-api/Dockerfile",
    platform: 'linux/arm64',
});

const allowImageAccess = new awsClassic.iam.Policy("ecr-access-policy", {
    policy: {
        Version: "2012-10-17",
        Statement: [
            {
                Effect: "Allow",
                Action: [
                    "ecr:GetDownloadUrlForLayer",
                    "ecr:BatchGetImage",
                    "ecr:BatchCheckLayerAvailability"
                ],
                Resource: ecrRepo.arn
            },
            {
                Effect: "Allow",
                Action: [
                    "ecr:GetAuthorizationToken"
                ],
                Resource: "*"
            }
        ]
    }
});

const taskExecutionRolePolicyAttachment = new awsClassic.iam.RolePolicyAttachment("task-execution-role-policy-attachment", {
    role: ecsTaskInitializationRole.name,
    policyArn: allowImageAccess.arn,
});

const logGroup = new awsClassic.cloudwatch.LogGroup("website-task-logs", {
    retentionInDays: 14, // Specify the retention period for the logs
});

const todoAppTask = new awsnative.ecs.TaskDefinition("todo-app-task", {
    // Name of the family of tasks this belongs to - this is used to group tasks together (for versioning)
    family: "todo-app-task",
    // vCPUs for your task - they use a weird unit here:
    // 256 = 0.25 vCPU
    // 512 = 0.5 vCPU
    // 1024 = 1 vCPU
    // 2048 = 2 vCPU
    // 4096 = 4 vCPU
    // See available CPU sized here: https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_definition_parameters.html#task_size
    cpu: "256",
    // Memory in MB - depending on the vCPU setting, there's different RAM settings which you can use
    // → See available combos here: https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_definition_parameters.html#task_size
    memory: "512",
    // Needs to be "awsvpc" since we're using Fargate
    networkMode: "awsvpc",
    requiresCompatibilities: ["FARGATE"],
    executionRoleArn: ecsTaskInitializationRole.arn,
    containerDefinitions: [{
        name: "todo-app",
        image: todoAppImage.imageUri,
        portMappings: [{
            containerPort: 80,
            hostPort: 80,
            protocol: "tcp",
        }],
        logConfiguration: {
            logDriver: 'awslogs',
            options: {
                "awslogs-group": logGroup.name,
                "awslogs-region": pulumi.output(awsClassic.getRegion({}, { async: true })).name,
                "awslogs-stream-prefix": "ecs",
            }
        },
    }],
    runtimePlatform: {
        cpuArchitecture: 'ARM64',
    }
});

const todoTable = new awsClassic.dynamodb.Table("abe-todos", {
    billingMode: "PAY_PER_REQUEST",
    hashKey: "id",
    attributes: [
        {
            name: 'id',
            type: 'S',
        }
    ],
});

const allowTableAccess = new awsClassic.iam.Policy("allow-table-access", {
    policy: {
        Version: "2012-10-17",
        Statement: [
            {
                Effect: "Allow",
                Action: "*",
                Resource: todoTable.arn,
            },
        ]
    }
});

// Confusingly "execution role" is the role used during task initialization (e.g. pulling images from AWS ECR),
// while the "task role" is the role used during the execution of the task (e.g. while it's running and receiving requests, making DB calls etc.)
// See more details in this reddit thread: https://www.reddit.com/r/aws/comments/yxfhyj/comment/iwoj7ld/?utm_source=share&utm_medium=web3x&utm_name=web3xcss&utm_term=1&utm_content=share_button
const ecsTaskRole = new awsClassic.iam.Role("task-role", {
    assumeRolePolicy: {
        Version: "2008-10-17",
        Statement: [{
            Sid: "",
            Effect: "Allow",
            Principal: {
                Service: "ecs-tasks.amazonaws.com",
            },
            Action: "sts:AssumeRole",
        }],
    },
});

const allowTableAccessPolicyAttachment = new awsClassic.iam.RolePolicyAttachment("allow-table-access-policy-attachment", {
    role: ecsTaskRole.name,
    policyArn: allowTableAccess.arn,
});

const todoApiTask = new awsnative.ecs.TaskDefinition("todo-api-task", {
    // Name of the family of tasks this belongs to - this is used to group tasks together (for versioning)
    family: "todo-api-task",
    // vCPUs for your task - they use a weird unit here:
    // 256 = 0.25 vCPU
    // 512 = 0.5 vCPU
    // 1024 = 1 vCPU
    // 2048 = 2 vCPU
    // 4096 = 4 vCPU
    // See available CPU sized here: https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_definition_parameters.html#task_size
    cpu: "256",
    // Memory in MB - depending on the vCPU setting, there's different RAM settings which you can use
    // → See available combos here: https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_definition_parameters.html#task_size
    memory: "512",
    // Needs to be "awsvpc" since we're using Fargate
    networkMode: "awsvpc",
    requiresCompatibilities: ["FARGATE"],
    executionRoleArn: ecsTaskInitializationRole.arn,
    taskRoleArn: ecsTaskRole.arn,
    containerDefinitions: [{
        name: "todo-api",
        image: todoApiImage.imageUri,
        portMappings: [{
            containerPort: 80,
            hostPort: 80,
            protocol: "tcp",
        }],
        environment: [
            { name: 'AWS_REGION', value: 'eu-central-1' },
            { name: 'DYNAMODB_TABLE_NAME', value: todoTable.name },
            { name: 'PORT', value: '80' },
        ],
        logConfiguration: {
            logDriver: 'awslogs',
            options: {
                "awslogs-group": logGroup.name,
                "awslogs-region": pulumi.output(awsClassic.getRegion({}, { async: true })).name,
                "awslogs-stream-prefix": "ecs",
            }
        },
    }],
    runtimePlatform: {
        cpuArchitecture: 'ARM64',
    }
});

const todoAppService = new awsnative.ecs.Service("todo-app-service", {
    cluster: cluster.arn,
    desiredCount: 1,
    launchType: "FARGATE",
    taskDefinition: todoAppTask.taskDefinitionArn,
    networkConfiguration: {
        awsvpcConfiguration: {
            assignPublicIp: "ENABLED",
            subnets: defaultVpcSubnets.ids,
            securityGroups: [group.id],
        },
    },
    loadBalancers: [{
        targetGroupArn: todoAppTg.arn,
        containerName: "todo-app",
        containerPort: 80,
    }],
}, { dependsOn: [httpsRedirectListener, todoListener] });

const todoApiService = new awsnative.ecs.Service("todo-api-service", {
    cluster: cluster.arn,
    desiredCount: 1,
    launchType: "FARGATE",
    taskDefinition: todoApiTask.taskDefinitionArn,
    networkConfiguration: {
        awsvpcConfiguration: {
            assignPublicIp: "ENABLED",
            subnets: defaultVpcSubnets.ids,
            securityGroups: [group.id],
        },
    },
    loadBalancers: [{
        targetGroupArn: todoApiTg.arn,
        containerName: "todo-api",
        containerPort: 80,
    }],
}, { dependsOn: [httpsRedirectListener, todoListener, todoApiListenerRule] });

// As a last step, let's add some auto-scaling so we can be sure our services scale up- and down with demand (making them more resilient)!
const todoAppScalingTarget = new awsClassic.appautoscaling.Target("todo-app-service-scaling-target", {
    maxCapacity: 10,
    minCapacity: 1,
    resourceId: pulumi.interpolate`service/${cluster.clusterName}/${todoAppService.serviceName}`,
    scalableDimension: "ecs:service:DesiredCount",
    serviceNamespace: "ecs",
});

const todoAppScalingPolicy = new awsClassic.appautoscaling.Policy("todo-app-scaledown-policy", {
    policyType: "StepScaling",
    resourceId: todoAppScalingTarget.resourceId,
    scalableDimension: todoAppScalingTarget.scalableDimension,
    serviceNamespace: todoAppScalingTarget.serviceNamespace,
    stepScalingPolicyConfiguration: {
        adjustmentType: "ChangeInCapacity",
        cooldown: 60,
        metricAggregationType: "Maximum",
        stepAdjustments: [{
            metricIntervalUpperBound: "0",
            scalingAdjustment: -1,
        }],
    },
});

const todoApiScalingTarget = new awsClassic.appautoscaling.Target("todo-api-service-scaling-target", {
    maxCapacity: 10,
    minCapacity: 1,
    resourceId: pulumi.interpolate`service/${cluster.clusterName}/${todoApiService.serviceName}`,
    scalableDimension: "ecs:service:DesiredCount",
    serviceNamespace: "ecs",
});

const todoApiScalingPolicy = new awsClassic.appautoscaling.Policy("todo-api-scaledown-policy", {
    policyType: "StepScaling",
    resourceId: todoApiScalingTarget.resourceId,
    scalableDimension: todoApiScalingTarget.scalableDimension,
    serviceNamespace: todoApiScalingTarget.serviceNamespace,
    stepScalingPolicyConfiguration: {
        adjustmentType: "ChangeInCapacity",
        cooldown: 60,
        metricAggregationType: "Maximum",
        stepAdjustments: [{
            metricIntervalUpperBound: "0",
            scalingAdjustment: -1,
        }],
    },
});

export const publicUrl = YOUR_DOMAIN;
export const publicApiUrl = `${YOUR_DOMAIN}/api`