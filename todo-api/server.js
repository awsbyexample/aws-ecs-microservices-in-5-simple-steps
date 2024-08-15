const express = require('express');
const bodyParser = require('body-parser');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, ScanCommand, PutCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(bodyParser.json());
app.use(cors());

// Configure AWS SDK using environment variables
const REGION = process.env.AWS_REGION;
const TABLE_NAME = process.env.DYNAMODB_TABLE_NAME;
const dynamoDbClient = new DynamoDBClient({ region: REGION });
const ddbDocClient = DynamoDBDocumentClient.from(dynamoDbClient);

// Create a router
const apiRouter = express.Router();

apiRouter.get('/todos', async (req, res) => {
    const params = {
        TableName: TABLE_NAME
    };

    try {
        const data = await ddbDocClient.send(new ScanCommand(params));
        res.json(data.Items);
    } catch (error) {
        console.error('Error fetching todos:', error);
        res.status(500).json({ error: 'Could not fetch todos' });
    }
});

apiRouter.post('/todos', async (req, res) => {
    const todo = {
        id: Date.now().toString(),
        text: req.body.text,
        completed: false
    };

    const params = {
        TableName: TABLE_NAME,
        Item: todo
    };

    try {
        await ddbDocClient.send(new PutCommand(params));
        res.status(201).json(todo);
    } catch (error) {
        console.error('Error adding todo:', error);
        res.status(500).json({ error: 'Could not add todo' });
    }
});

apiRouter.patch('/todos/:id', async (req, res) => {
    const { id } = req.params;
    const { completed } = req.body;

    const params = {
        TableName: TABLE_NAME,
        Key: { id },
        UpdateExpression: 'set completed = :completed',
        ExpressionAttributeValues: {
            ':completed': completed
        },
        ReturnValues: 'ALL_NEW'
    };

    try {
        const data = await ddbDocClient.send(new UpdateCommand(params));
        res.json(data.Attributes);
    } catch (error) {
        console.error('Error updating todo:', error);
        res.status(500).json({ error: 'Could not update todo' });
    }
});

apiRouter.get('/', (req, res) => {
    res.status(200).json({ status: 'ok' });
});

// Use the API router with a base path
app.use('/api', apiRouter);

// 404 handler
app.use((req, res, next) => {
    console.error(`404 Not Found: ${req.originalUrl}`);
    res.status(404).json({ error: 'Not Found' });
});

app.use(express.static('.'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running at http://localhost:${PORT}/`);
});