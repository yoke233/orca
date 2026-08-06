import { Monitor, MoreVertical } from 'lucide-react-native'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import type { ConnectionVerdict } from '../transport/connection-health'
import type { MobileConnectionPath } from '../transport/stable-logical-rpc-client'
import type { ConnectionState, HostCatalogEntry, HostProfile } from '../transport/types'
import { colors, radii, spacing } from '../theme/mobile-theme'
import { useMobileLocale } from '../localization/mobile-locale-provider'
import type { TranslationKey } from '../localization/mobile-locale'
import { homeHostWorktreeSummary, type HostWorktreeInfo } from '../worktree/home-worktree-info'
import { StatusDot } from './StatusDot'

function connectionStatusKey(state: ConnectionState, verdict: ConnectionVerdict): TranslationKey {
  if (verdict.kind === 'auth-failed') {
    return 'host.pairingInvalid'
  }
  if (verdict.kind === 'unreachable') {
    return 'host.cantReachDesktop'
  }
  if (verdict.kind === 'warning') {
    return 'host.cantConnect'
  }
  if (state === 'connected') {
    return 'host.connected'
  }
  if (state === 'disconnected') {
    return 'host.disconnected'
  }
  return state === 'reconnecting' ? 'host.reconnecting' : 'host.connecting'
}

export function MobileHostCard(props: {
  host: HostProfile | HostCatalogEntry
  credentialStatus?: HostCatalogEntry['credentialStatus']
  state: ConnectionState
  verdict: ConnectionVerdict
  path: MobileConnectionPath
  // Why: the card owns the fresh/stale/unavailable wording so no caller can re-gate the counts
  // away (STA-3123 shipped that bug once already).
  worktreeInfo?: HostWorktreeInfo
  onPress: () => void
  onLongPress: () => void
  onOpenActions: () => void
}) {
  const { t } = useMobileLocale()
  const credentialUnavailable = props.credentialStatus === 'temporarily-unavailable'
  const credentialMissing = props.credentialStatus === 'missing'
  const connected = props.state === 'connected' && !credentialUnavailable && !credentialMissing
  // Why: a relay dial can run for seconds behind "Connecting…"/"Reconnecting…"; naming the
  // path mid-wait tells the user the phone is off-LAN rather than hung (F5). Only 'relay' is
  // named — 'lan' doubles as the unknown-path default, so it would be a guess before connect.
  const dialingPath =
    ['connecting', 'handshaking', 'reconnecting'].includes(props.state) && props.path === 'relay'
  const isError =
    credentialMissing || ['warning', 'unreachable', 'auth-failed'].includes(props.verdict.kind)
  const statusLabel = credentialMissing
    ? t('host.pairingInvalidStatus')
    : credentialUnavailable
      ? t('host.pairingTemporarilyUnavailable')
      : t(connectionStatusKey(props.state, props.verdict))
  const displayStatus =
    !credentialMissing &&
    !credentialUnavailable &&
    (props.verdict.kind === 'warning' || props.verdict.kind === 'unreachable') &&
    props.verdict.hint
      ? t('host.statusWithHint', {
          status: statusLabel,
          hint:
            props.verdict.hint === 'check Tailscale' ? t('host.checkTailscale') : props.verdict.hint
        })
      : statusLabel
  const statusVerdict: ConnectionVerdict = credentialMissing
    ? { kind: 'auth-failed', label: statusLabel }
    : credentialUnavailable
      ? { kind: 'warning', label: statusLabel }
      : props.verdict
  const connectionPath =
    props.path === 'relay'
      ? t('host.pathRelay')
      : props.path === 'tailscale'
        ? t('host.pathTailscale')
        : t('host.pathLan')
  const worktreeSummary = homeHostWorktreeSummary(props.worktreeInfo, Date.now(), {
    unavailable: t('host.worktreeListUnavailable'),
    worktrees: (count) => t(count === 1 ? 'host.worktreeOne' : 'host.worktreeMany', { count }),
    active: (count) => t('host.activeWorktrees', { count }),
    lastKnown: (summary) => t('host.lastKnownWorktrees', { summary })
  })
  const connectionPathLabel =
    !credentialMissing && !credentialUnavailable && (connected || dialingPath)
      ? connectionPath
      : null
  const discoveryHint =
    props.verdict.kind === 'unreachable' && !props.host.relay ? t('host.discoveryHint') : null
  const credentialHint = credentialMissing
    ? t('host.repairHint')
    : credentialUnavailable
      ? t('host.unlockRetryHint')
      : null
  const accessibilityLabel = [
    t('host.openAccessibility', { name: props.host.name }),
    displayStatus,
    connectionPathLabel?.replace(' · ', ' via '),
    connected ? worktreeSummary?.replace(' · ', ', ') : null,
    discoveryHint,
    credentialHint
  ]
    .filter(Boolean)
    .join(', ')
  return (
    <View style={styles.card}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        style={({ pressed }) => [styles.cardMain, pressed && styles.cardPressed]}
        onPress={props.onPress}
        onLongPress={props.onLongPress}
        delayLongPress={400}
      >
        <View style={styles.icon}>
          <Monitor size={20} color={connected ? colors.textPrimary : colors.textSecondary} />
        </View>
        <View style={styles.main}>
          <Text
            style={[styles.name, !connected && { color: colors.textSecondary }]}
            numberOfLines={1}
          >
            {props.host.name}
          </Text>
          <View style={styles.meta}>
            <StatusDot state={props.state} verdict={statusVerdict} />
            <Text
              style={[
                styles.metaText,
                isError && { color: colors.statusRed },
                credentialUnavailable && { color: colors.statusAmber }
              ]}
              numberOfLines={1}
            >
              {displayStatus}
              {connectionPathLabel ? ` · ${connectionPathLabel}` : ''}
            </Text>
          </View>
          {connected && worktreeSummary ? (
            <Text style={styles.worktreeMetaText} numberOfLines={1}>
              {worktreeSummary}
            </Text>
          ) : null}
          {discoveryHint ? (
            <Text style={styles.discoveryHint} numberOfLines={2}>
              {discoveryHint}
            </Text>
          ) : null}
          {credentialHint ? (
            <Text style={styles.discoveryHint} numberOfLines={2}>
              {credentialHint}
            </Text>
          ) : null}
        </View>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('host.actionsAccessibility', { name: props.host.name })}
        hitSlop={8}
        style={({ pressed }) => [styles.actionButton, pressed && styles.actionButtonPressed]}
        onPress={props.onOpenActions}
      >
        <MoreVertical size={18} color={colors.textSecondary} />
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: radii.card,
    backgroundColor: colors.bgPanel,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    overflow: 'hidden'
  },
  cardMain: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: spacing.md,
    paddingVertical: 12
  },
  cardPressed: { backgroundColor: colors.bgRaised },
  icon: {
    width: 46,
    height: 46,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgRaised,
    marginRight: 14
  },
  main: { flex: 1, minWidth: 0, marginRight: spacing.sm },
  name: { color: colors.textPrimary, fontSize: 15, fontWeight: '600', lineHeight: 20 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3, minWidth: 0 },
  metaText: { flex: 1, fontSize: 12, color: colors.textSecondary },
  worktreeMetaText: {
    marginTop: 2,
    marginLeft: spacing.xl,
    fontSize: 12,
    color: colors.textMuted
  },
  discoveryHint: {
    marginTop: spacing.xs,
    fontSize: 11,
    lineHeight: 15,
    color: colors.textMuted
  },
  actionButton: {
    width: 40,
    height: 40,
    marginHorizontal: spacing.xs,
    borderRadius: radii.row,
    alignItems: 'center',
    justifyContent: 'center'
  },
  actionButtonPressed: {
    backgroundColor: colors.bgRaised
  }
})
