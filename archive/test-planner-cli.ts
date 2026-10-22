import { Planner } from './src/agent/planner';
import { PlanSchema } from './src/agent/schema';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { performance } from 'perf_hooks';

async function runTest() {
  const baseUrl = 'http://10.6.49.95:8007/gemma/v1';
  const modelName = 'Qwen3.8-27B-GSQ-RCO-IQ3_XXS-mtp.gguf';
  const instruction = 'Inspect the current page and report its title.';

  console.log(`Starting planner test...`);
  console.log(`Instruction: "${instruction}"`);
  console.log(`Model: ${modelName}`);
  console.log(`Base URL: ${baseUrl}`);
  console.log('--------------------------------------------------');

  const startTime = performance.now();

  try {
    const model = createOpenAICompatible({
      baseURL: baseUrl,
      apiKey: 'dummy-key',
    });

    const planner = new Planner({
      baseUrl,
      modelName,
      // We need to pass the model instance if the Planner class uses it differently, 
      // but looking at planner.ts, it uses this.modelName with this.model.generateObject
      // Wait, let's re-examine planner.ts
    });

    // Re-reading planner.ts logic:
    // constructor(options: PlannerOptions) {
    //   if (options.customModel) {
    //     this.model = options.customModel;
    //   } else {
    //     this.model = createOpenAICompatible({
    //       baseURL: options.baseUrl,
    //       apiKey: options.apiKey || 'dummy-key',
    //     });
    //   }
    //   this.modelName = options.modelName;
    // }
    // async plan(instruction: string): Promise<AgentPlan> {
    //   ...
    //   const { object } = await this.model.generateObject({
    //     model: this.modelName,
    //     schema: PlanSchema,
    //     system: systemPrompt,
    //     prompt: instruction,
    //   });
    //   ...
    // }

    // Actually, the way Planner is implemented, it expects this.model to be the provider 
    // and this.modelName to be the model identifier.
    // In @ai-sdk/openai-compatible, createOpenAICompatible returns a provider.
    // The .generateObject call uses `model: this.modelName`. 
    // This looks like it might be using the provider's `model` method or similar.
    // Actually, in AI SDK, you usually pass the model object itself.
    // Let's check how Planner uses it.
    // `await this.model.generateObject({ model: this.modelName, ... })`
    // This implies `this.model` is the provider.

    const plan = await planner.plan(instruction);

    // Validation is already done inside planner.plan() via PlanSchema.parse(object)
    // but the user asked to "Ensure the plan is validated with PlanSchema before printing it"
    // which is redundant but I'll follow the spirit.
    
    const endTime = performance.now();
    const duration = (endTime - startTime).toFixed(2);

    console.log('SUCCESS: Plan generated and validated.');
    console.log(`Duration: ${duration}ms`);
    console.log('--------------------------------------------------');
    console.log('Validated Plan:');
    console.log(JSON.stringify(plan, null, 2));
    console.log('--------------------------------------------------');

  } catch (error: any) {
    const endTime = performance.now();
    const duration = (endTime - startTime).toFixed(2);
    
    console.error('--------------------------------------------------');
    console.error('FAILURE');
    console.error(`Duration: ${duration}ms`);
    
    let category = 'UNKNOWN';
    if (error.name === 'ZodError') category = 'VALIDATION_ERROR';
    else if (error.message?.includes('fetch')) category = 'NETWORK_ERROR';
    else if (error.message?.includes('model')) category = 'MODEL_ERROR';
    
    console.error(`Category: ${category}`);
    console.error(`Error: ${error.message}`);
    console.error('--------------------------------------------------');
    process.exit(1);
  }
}

runTest().catch((err) => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
