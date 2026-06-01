import { Activity, X, ExternalLink, Server, Container } from 'lucide-react';
import { ContainerCard, type HelixConfig } from './ContainerCard';

type Props = {
  isOpen: boolean;
  onClose: () => void;
  hasRealHelixEndpoint: boolean;
  helixConfig: HelixConfig;
  discoveredContainers: any[];
  loadingContainers: Set<string>;
  onAttach: (name: string) => void;
  onDisconnect: (name: string) => void;
};

// Pinned right-hand drawer listing containers discovered on the Docker host,
// split into core infrastructure (the gateway) and local applications, each
// with attach/disconnect controls. Slides in/out via the isOpen flag.
export const DiscoveredServicesDrawer = ({
  isOpen,
  onClose,
  hasRealHelixEndpoint,
  helixConfig,
  discoveredContainers,
  loadingContainers,
  onAttach,
  onDisconnect,
}: Props) => {
  const renderCard = (container: any, isCore: boolean) => (
    <ContainerCard
      key={container.name}
      container={container}
      isCore={isCore}
      hasRealHelixEndpoint={hasRealHelixEndpoint}
      helixConfig={helixConfig}
      loadingContainers={loadingContainers}
      onAttach={onAttach}
      onDisconnect={onDisconnect}
    />
  );

  const apps = discoveredContainers.filter(c => !c.name.includes('helix-gateway'));

  return (
    <div
      className={`relative w-[450px] h-full flex-shrink-0 bg-gray-1000 border-l border-gray-700 shadow-4 flex flex-col transition-all duration-300 ease-in-out ${isOpen ? 'translate-x-0' : 'hidden'}`}
      role={isOpen ? 'dialog' : undefined}
      aria-modal={isOpen ? true : undefined}
      aria-labelledby="discovered-services-title"
      aria-hidden={!isOpen}
    >
      <div className="bg-gray-900 px-4 border-b border-gray-700 flex items-center justify-between flex-shrink-0 h-[52px]">
        <h2 id="discovered-services-title" className="text-lg font-semibold flex items-center gap-2">
          <Activity className="w-5 h-5 text-link" />
          Discovered Services
        </h2>
        <button
          onClick={onClose}
          className="text-gray-400 hover:text-white p-1"
          aria-label="Close discovered services panel"
        >
          <X className="w-6 h-6" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-6 space-y-8">
        {/* Namespace Dashboard Link */}
        {hasRealHelixEndpoint && (
          <a
            href={`${helixConfig.baseUrl}/dashboards/d/OTelNamespaceOverview/otel-namespace-overview?orgId=${helixConfig.tenantId}&var-BusinessService=${helixConfig.source}&var-OTelNamespace=${helixConfig.source}&from=now-3h&to=now&timezone=browser`}
            target="_blank"
            rel="noreferrer"
            className="bg-info/10 border border-info/30 hover:bg-info/20 p-4 rounded-lg flex items-center justify-between group transition-all mb-6 block"
          >
            <div className="flex flex-col">
              <span className="text-info text-sm font-bold flex items-center gap-2">
                View Namespace Dashboard
                <ExternalLink className="w-4 h-4" />
              </span>
            </div>
          </a>
        )}

        {/* Section: Core Infrastructure */}
        <section className="space-y-4">
          <div className="flex items-center gap-2 text-xs font-bold text-gray-500 uppercase tracking-widest">
            <Server className="w-4 h-4" />
            Core Infrastructure
          </div>
          <div className="space-y-3">
            {discoveredContainers
              .filter(c => c.name.includes('helix-gateway'))
              .map(container => renderCard(container, true))}
          </div>
        </section>

        {/* Section: Local Applications */}
        <section className="space-y-4">
          <div className="flex items-center gap-2 text-xs font-bold text-gray-500 uppercase tracking-widest">
            <Container className="w-4 h-4" />
            Local Applications
          </div>
          <div className="space-y-3">
            {apps.length === 0 ? (
              <div className="border border-dashed border-gray-700 rounded-lg p-5 text-center text-sm text-gray-400 bg-gray-1000/50">
                <p className="text-gray-300 font-semibold mb-1">No applications discovered</p>
                <p className="text-tiny">Start your application on this Docker host, then click Discovered Services again to refresh.</p>
              </div>
            ) : (
              apps.map(container => renderCard(container, false))
            )}
          </div>
        </section>
      </div>
    </div>
  );
};
