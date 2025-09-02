#!/usr/bin/env node

// Simple integration test for queue system
// This bypasses TypeScript compilation issues

import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';

const redis = new IORedis({
  host: 'localhost',
  port: 6379,
  maxRetriesPerRequest: 3,
});

const QUEUE_NAME = 'test-scrape-reviews';

async function testQueueIntegration() {
  console.log('🚀 Testing Queue Integration...');
  
  try {
    // Test Redis connection
    const pong = await redis.ping();
    console.log('✅ Redis connection:', pong === 'PONG' ? 'OK' : 'FAILED');
    
    // Create queue
    const queue = new Queue(QUEUE_NAME, { connection: redis });
    
    // Create worker
    const worker = new Worker(QUEUE_NAME, async (job) => {
      console.log(`📋 Processing job ${job.id} with data:`, job.data);
      
      // Simulate work
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      return {
        success: true,
        message: `Processed job ${job.id}`,
        itemsProcessed: job.data.appId ? 1 : 0,
      };
    }, { 
      connection: redis,
      concurrency: 1 
    });
    
    // Set up event handlers
    worker.on('completed', (job, result) => {
      console.log('✅ Job completed:', job.id, result);
    });
    
    worker.on('failed', (job, error) => {
      console.log('❌ Job failed:', job?.id, error.message);
    });
    
    // Add a test job
    console.log('📤 Adding test job to queue...');
    const job = await queue.add('test-scrape', {
      appId: 'test-app-123',
      countries: ['us'],
      pages: 1,
      sortMethods: ['recent'],
      priority: 5,
      retryAttempts: 3,
    });
    
    console.log('✅ Job added with ID:', job.id);
    
    // Wait for job to complete
    await new Promise(resolve => {
      worker.on('completed', () => {
        resolve();
      });
    });
    
    // Get queue stats
    const waiting = await queue.getWaiting();
    const active = await queue.getActive();
    const completed = await queue.getCompleted();
    
    console.log('📊 Queue Stats:');
    console.log('  - Waiting:', waiting.length);
    console.log('  - Active:', active.length);  
    console.log('  - Completed:', completed.length);
    
    // Cleanup
    await worker.close();
    await queue.close();
    await redis.quit();
    
    console.log('🎉 Queue integration test completed successfully!');
    
  } catch (error) {
    console.error('❌ Queue integration test failed:', error);
    process.exit(1);
  }
}

// Run the test
testQueueIntegration();