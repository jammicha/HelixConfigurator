import { BarChart2, Unlink, Loader2 } from 'lucide-react';

export type HelixConfig = {
  baseUrl: string;
  tenantId: string;
  source: string;
  businessServiceKey: string;
};

type Props = {
  container: any;
  // Core containers (the gateway itself) render without attach/disconnect
  // controls — they're shown for context, not management.
  isCore?: boolean;
  hasRealHelixEndpoint: boolean;
  helixConfig: HelixConfig;
  loadingContainers: Set<string>;
  onAttach: (name: string) => void;
  onDisconnect: (name: string) => void;
};

// One row in the "Discovered Services" drawer: a container's name/image plus
// its bridge-connection state and the attach / disconnect / dashboard actions.
export const ContainerCard = ({
  container,
  isCore = false,
  hasRealHelixEndpoint,
  helixConfig,
  loadingContainers,
  onAttach,
  onDisconnect,
}: Props) => {
  const isLoading = loadingContainers.has(container.name);
  const onBridge = container.networks.includes('helix-bridge');
  return (
    <div className={`border border-gray-800 p-4 rounded-lg flex items-center justify-between transition-colors ${isCore ? 'bg-blue-500/5' : 'bg-gray-900'}`}>
      <div className="flex flex-col min-w-0">
        <span className="font-bold text-gray-200 text-sm truncate">{container.name}</span>
        <span className="text-[10px] text-gray-500 truncate">{container.image}</span>
      </div>
      <div className="flex items-center gap-3">
        {onBridge ? (
          <div className="flex items-center gap-2">
            <span className="adapt-badge-success gap-1.5">
              <div className="w-1.5 h-1.5 rounded-full bg-[#11845b] flex-shrink-0"></div>
              Connected
            </span>
            {hasRealHelixEndpoint && (
              <a
                href={`${helixConfig.baseUrl}/dashboards/d/OTelServiceOverview/otel-service-overview?orgId=${helixConfig.tenantId}&from=now-3h&to=now&timezone=browser&var-BusinessService=${helixConfig.source}&var-OTelNamespace=${helixConfig.source}&var-OTelService=${container.name}&var-status=STATUS_CODE_UNSET`}
                target="_blank"
                rel="noreferrer"
                className="p-1.5 bg-gray-800 hover:bg-gray-700 rounded text-info transition-colors"
                title="View Service Dashboard"
                aria-label={`View Service Dashboard for ${container.name}`}
              >
                <BarChart2 className="w-4 h-4" />
              </a>
            )}
            {!isCore && (
              <button
                onClick={() => onDisconnect(container.name)}
                disabled={isLoading}
                className="text-gray-400 hover:text-danger-text transition-colors p-1 disabled:opacity-60"
                title="Disconnect from Bridge"
                aria-label={`Disconnect ${container.name} from helix-bridge`}
              >
                <Unlink className="w-4 h-4" />
              </button>
            )}
          </div>
        ) : (
          !isCore && (
            <button
              onClick={() => onAttach(container.name)}
              disabled={isLoading}
              className="text-info text-xs font-bold hover:underline disabled:opacity-60 flex items-center gap-2"
            >
              {isLoading && <Loader2 className="w-3 h-3 animate-spin" />}
              {isLoading ? 'Attaching...' : 'Attach to Bridge'}
            </button>
          )
        )}
      </div>
    </div>
  );
};
