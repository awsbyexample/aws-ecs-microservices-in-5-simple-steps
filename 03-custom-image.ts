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
const atg = new awsClassic.lb.TargetGroup("app-tg", {
    port: 80,
    protocol: "HTTP",
    targetType: "ip",
    vpcId: defaultVpc.id,
});

// The role that the ECS tasks will receive once it's running
const role = new awsClassic.iam.Role("task-exec-role", {
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
    role: role.name,
    policyArn: "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy",
});

/**
 * Native AWS provider stuff
 */
// Cluster -[has multiple]→ Services -[has multiple]→ Tasks -[has 1-x]→ Containers
const cluster = new awsnative.ecs.Cluster("cluster", {
    clusterName: "aws-by-example-cluster",
});

const wl = new awsnative.elasticloadbalancingv2.Listener("web", {
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
    name: YOUR_DOMAIN,
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

const secureWebListener = new awsnative.elasticloadbalancingv2.Listener("https-web", {
    loadBalancerArn: alb.arn,
    certificates: [{
        certificateArn: certificate.arn,
    }],
    port: 443,
    protocol: "HTTPS",
    defaultActions: [{
        type: "forward",
        targetGroupArn: atg.arn,
    }],
});

// Now, let's setup our own website as the image we're using
const ecrRepo = new awsClassic.ecr.Repository("ecr-repo", {
    name: "abe-example-ecr-repo",
    imageTagMutability: "MUTABLE",
    imageScanningConfiguration: {
        scanOnPush: true,
    },
});

// For our AWS examples, we like to avoid using Pulumi Crosswalk (=components that implement architectural best-practises) to *actually*
// understand how to build everything by hand, *however* the awsx.ecr.Image construct is a really elegant piece of tech that makes our lifes far simpler :)
const websiteImage = new awsx.ecr.Image("website-image", {
    repositoryUrl: ecrRepo.repositoryUrl,
    context: "./simple-website",
    dockerfile: "./simple-website/Dockerfile",
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
    role: role.name,
    policyArn: allowImageAccess.arn,
});

const logGroup = new awsClassic.cloudwatch.LogGroup("website-task-logs", {
    retentionInDays: 14, // Specify the retention period for the logs
});

const taskDefinition = new awsnative.ecs.TaskDefinition("website-task", {
    // Name of the family of tasks this belongs to - this is used to group tasks together (for versioning)
    family: "abe-example-website",
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
    executionRoleArn: role.arn,
    containerDefinitions: [{
        name: "custom-website",
        image: websiteImage.imageUri,
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

const service = new awsnative.ecs.Service("website-service", {
    serviceName: "abe-example-website",
    cluster: cluster.arn,
    desiredCount: 1,
    launchType: "FARGATE",
    taskDefinition: taskDefinition.taskDefinitionArn,
    networkConfiguration: {
        awsvpcConfiguration: {
            assignPublicIp: "ENABLED",
            subnets: defaultVpcSubnets.ids,
            securityGroups: [group.id],
        },
    },
    loadBalancers: [{
        targetGroupArn: atg.arn,
        containerName: "custom-website",
        containerPort: 80,
    }],
}, { dependsOn: [wl, secureWebListener] });

export const publicUrl = alb.dnsName;