interface HardwareCapability {
  gpu: boolean;
  memory: number;
  cudaVersion?: string;
  vram?: number;
  priority: number;
}

interface HardwareNode {
  id: string;
  capabilities: HardwareCapability;
  load: number;
  healthy: boolean;
  lastSeen: Date;
}

interface TaskRequirement {
  requiresGPU: boolean;
  minMemory: number;
  preferredCudaVersion?: string;
  minVRAM?: number;
  timeout: number;
}

interface RoutingPolicy {
  name: string;
  strategy: 'performance' | 'balanced' | 'conservative';
  fallbackChain: string[];
  enabled: boolean;
}

class HardwareRegistry {
  private nodes: Map<string, HardwareNode> = new Map();
  private policies: Map<string, RoutingPolicy> = new Map();

  constructor() {
    this.initializeDefaultPolicies();
  }

  private initializeDefaultPolicies(): void {
    this.policies.set('default', {
      name: 'default',
      strategy: 'balanced',
      fallbackChain: ['gpu-high-mem', 'gpu-low-mem', 'cpu-high-mem'],
      enabled: true
    });

    this.policies.set('gpu-intensive', {
      name: 'gpu-intensive',
      strategy: 'performance',
      fallbackChain: ['gpu-high-vram', 'gpu-low-vram', 'cpu-high-mem'],
      enabled: true
    });
  }

  registerNode(id: string, capabilities: HardwareCapability): void {
    this.nodes.set(id, {
      id,
      capabilities,
      load: 0,
      healthy: true,
      lastSeen: new Date()
    });
  }

  updateNodeHealth(id: string, healthy: boolean): void {
    const node = this.nodes.get(id);
    if (node) {
      node.healthy = healthy;
      node.lastSeen = new Date();
    }
  }

  updateNodeLoad(id: string, load: number): void {
    const node = this.nodes.get(id);
    if (node) {
      node.load = load;
    }
  }

  findOptimalNode(requirements: TaskRequirement, policyName: string = 'default'): string | null {
    const policy = this.policies.get(policyName);
    if (!policy || !policy.enabled) {
      return null;
    }

    const availableNodes = Array.from(this.nodes.values())
      .filter(node => node.healthy && node.load < 100);

    if (availableNodes.length === 0) {
      return null;
    }

    const matchingNodes = availableNodes.filter(node => 
      this.matchesRequirements(node.capabilities, requirements)
    );

    if (matchingNodes.length === 0) {
      for (const fallbackPolicy of policy.fallbackChain) {
        const fallbackNode = this.findOptimalNode(requirements, fallbackPolicy);
        if (fallbackNode) {
          return fallbackNode;
        }
      }
      return null;
    }

    return this.selectNodeByStrategy(matchingNodes, policy.strategy);
  }

  private matchesRequirements(capabilities: HardwareCapability, requirements: TaskRequirement): boolean {
    if (requirements.requiresGPU && !capabilities.gpu) {
      return false;
    }

    if (capabilities.memory < requirements.minMemory) {
      return false;
    }

    if (requirements.preferredCudaVersion && capabilities.cudaVersion) {
      const requiredVersion = parseFloat(requirements.preferredCudaVersion);
      const availableVersion = parseFloat(capabilities.cudaVersion);
      if (availableVersion < requiredVersion) {
        return false;
      }
    }

    if (requirements.minVRAM && capabilities.vram) {
      if (capabilities.vram < requirements.minVRAM) {
        return false;
      }
    }

    return true;
  }

  private selectNodeByStrategy(nodes: HardwareNode[], strategy: string): string {
    switch (strategy) {
      case 'performance':
        return nodes.sort((a, b) => 
          b.capabilities.priority - a.capabilities.priority ||
          b.capabilities.memory - a.capabilities.memory ||
          a.load - b.load
        )[0].id;

      case 'conservative':
        return nodes.sort((a, b) => 
          a.load - b.load ||
          a.capabilities.priority - b.capabilities.priority
        )[0].id;

      case 'balanced':
      default:
        return nodes.sort((a, b) => {
          const loadDiff = a.load - b.load;
          if (Math.abs(loadDiff) > 20) {
            return loadDiff;
          }
          return b.capabilities.priority - a.capabilities.priority;
        })[0].id;
    }
  }

  getAllNodes(): HardwareNode[] {
    return Array.from(this.nodes.values());
  }

  getAllPolicies(): RoutingPolicy[] {
    return Array.from(this.policies.values());
  }

  updatePolicy(name: string, policy: Partial<RoutingPolicy>): boolean {
    const existing = this.policies.get(name);
    if (!existing) {
      return false;
    }
    this.policies.set(name, { ...existing, ...policy });
    return true;
  }
}

const hardwareRegistry = new HardwareRegistry();

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Security-Policy": "default-src 'self'; script-src 'self'",
  "X-Frame-Options": "DENY",
  "Content-Type": "application/json"
};

async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (path === "/api/route" && request.method === "POST") {
    return handleRouteRequest(request);
  }

  if (path === "/api/hardware" && request.method === "GET") {
    return handleHardwareRequest();
  }

  if (path === "/api/policies" && request.method === "GET") {
    return handlePoliciesRequest(request);
  }

  if (path === "/health") {
    return new Response(JSON.stringify({ status: "healthy", timestamp: new Date().toISOString() }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }

  return new Response(JSON.stringify({ error: "Not found" }), {
    status: 404,
    headers: corsHeaders
  });
}

async function handleRouteRequest(request: Request): Promise<Response> {
  try {
    const body = await request.json();
    
    const requirements: TaskRequirement = {
      requiresGPU: body.requiresGPU || false,
      minMemory: body.minMemory || 1024,
      preferredCudaVersion: body.preferredCudaVersion,
      minVRAM: body.minVRAM,
      timeout: body.timeout || 30000
    };

    const policyName = body.policy || 'default';
    const nodeId = hardwareRegistry.findOptimalNode(requirements, policyName);

    if (!nodeId) {
      return new Response(JSON.stringify({ 
        error: "No suitable hardware available",
        fallbackAttempted: true 
      }), {
        status: 503,
        headers: corsHeaders
      });
    }

    hardwareRegistry.updateNodeLoad(nodeId, 
      hardwareRegistry.getAllNodes().find(n => n.id === nodeId)!.load + 10
    );

    return new Response(JSON.stringify({ 
      nodeId,
      requirements,
      policy: policyName,
      timestamp: new Date().toISOString()
    }), {
      headers: corsHeaders
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: "Invalid request body" }), {
      status: 400,
      headers: corsHeaders
    });
  }
}

function handleHardwareRequest(): Response {
  const nodes = hardwareRegistry.getAllNodes();
  return new Response(JSON.stringify({ 
    nodes,
    total: nodes.length,
    healthy: nodes.filter(n => n.healthy).length
  }), {
    headers: corsHeaders
  });
}

function handlePoliciesRequest(request: Request): Response {
  const url = new URL(request.url);
  const name = url.searchParams.get("name");
  
  if (name) {
    const policy = hardwareRegistry.getAllPolicies().find(p => p.name === name);
    if (!policy) {
      return new Response(JSON.stringify({ error: "Policy not found" }), {
        status: 404,
        headers: corsHeaders
      });
    }
    return new Response(JSON.stringify(policy), { headers: corsHeaders });
  }

  const policies = hardwareRegistry.getAllPolicies();
  return new Response(JSON.stringify({ policies }), { headers: corsHeaders });
}

hardwareRegistry.registerNode("gpu-node-1", {
  gpu: true,
  memory: 32768,
  cudaVersion: "11.8",
  vram: 8192,
  priority: 90
});

hardwareRegistry.registerNode("gpu-node-2", {
  gpu: true,
  memory: 16384,
  cudaVersion: "11.4",
  vram: 4096,
  priority: 75
});

hardwareRegistry.registerNode("cpu-node-1", {
  gpu: false,
  memory: 65536,
  priority: 60
});

hardwareRegistry.registerNode("cpu-node-2", {
  gpu: false,
  memory: 32768,
  priority: 50
});

export default {
  async fetch(request: Request): Promise<Response> {
    return handleRequest(request);
  }
};
