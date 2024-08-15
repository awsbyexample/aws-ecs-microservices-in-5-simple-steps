# AWS Microservices
Example that shows you how to deploy *public facing microservices* on AWS, using AWS ECS Fargate.  

This example is technically a *serverless* example, as we're using AWS Fargate which essentially let's you specify how many vCPUs + how much RAM you need for your container, and AWS will take care of the rest.

## Different stages of this example
To make it easier for you to follow along - this example is split into multiple stages. Each stage builds on top of the previous one, and adds more functionality:

1. [Simple microservice](./01-simple-microservice.ts)
2. [HTTPs only (with custom domain)](./02-https-only.ts)
3. [Using your own image](./03-custom-image.ts)
4. [Multiple services + config](./04-multiple-services.ts)
5. Autoscaling

To use them, (un)comment the relevant code in `index.ts`.

## Prerequisites
- AWS account
- Pulumi installed
- Route53 managed domain (=Route53 hosted zone to be exact)

> **💡 If you don't have a Route53 managed domain yet** - Don't worry, you can get one for pretty cheap:  
>  
> 1. Generate a random, available domain name here: https://www.dotomator.com/
> 2. Search for it on Route53 > Registered domains > Register domain ([link](https://us-east-1.console.aws.amazon.com/route53/domains/home#/DomainSearch))
> 3. .com domains are $14 / year, cheaper alternatives are `.co.uk .de` ($9 / year), `.nl .cz .link` ($10 / year) with the cheapest being `.click` for $3 / year ([full price list](https://d32ze2gidvkk54.cloudfront.net/Amazon_Route_53_Domain_Registration_Pricing_20140731.pdf))
> 4. After registration wait a few minutes until everything's done

## Limitations
- Only public facing microservices in this example (no internally communicating services)

## How to run
`pulumi up`