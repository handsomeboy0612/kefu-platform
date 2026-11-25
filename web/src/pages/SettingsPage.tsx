import React, { useState } from 'react'
import { TabPane, Tabs } from '@douyinfe/semi-ui'
import { useAuth } from '../auth'
import PageHeader from '../components/PageHeader'
import DeptSettingsTab from './settings/DeptSettingsTab'
import AccountsTab from './settings/AccountsTab'
import MembersTab from './settings/MembersTab'
import QualityTab from './settings/QualityTab'
import KpiRulesTab from './settings/KpiRulesTab'
import GroupSettingsTab from './settings/GroupSettingsTab'

const SettingsPage: React.FC = () => {
  const { user, dept } = useAuth()
  const isAdmin = user?.role === 'admin'
  const [tab, setTab] = useState('source')

  return (
    <div className="page">
      <PageHeader
        title="设置"
        desc="本部门的数据源、成员、AI 质检和考核规则，各部门分开设置，互不影响。"
        scope={dept?.name}
        scopeHint={isAdmin ? '总管理员可以在左侧切换部门，改哪个部门就切到哪个部门' : '只影响本部门'}
      />
      <Tabs type="line" activeKey={tab} onChange={setTab} keepDOM={false}>
        <TabPane tab="数据源与 AI" itemKey="source">
          <div style={{ paddingTop: 20 }}><DeptSettingsTab /></div>
        </TabPane>
        <TabPane tab="成员" itemKey="members">
          <div style={{ paddingTop: 20 }}><MembersTab /></div>
        </TabPane>
        {dept?.groupChat && (
          <TabPane tab="对公群" itemKey="group">
            <div style={{ paddingTop: 20 }}><GroupSettingsTab /></div>
          </TabPane>
        )}
        <TabPane tab="AI 质检" itemKey="quality">
          <div style={{ paddingTop: 20 }}><QualityTab /></div>
        </TabPane>
        <TabPane tab="考核规则" itemKey="kpi">
          <div style={{ paddingTop: 20 }}>
            <KpiRulesTab />
          </div>
        </TabPane>
        {isAdmin && (
          <TabPane tab="账号" itemKey="accounts">
            <div style={{ paddingTop: 20 }}><AccountsTab /></div>
          </TabPane>
        )}
      </Tabs>
    </div>
  )
}

export default SettingsPage
