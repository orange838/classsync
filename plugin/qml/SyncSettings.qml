import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import RinUI
import ClassWidgets.Plugins

PluginPage {
    id: root
    pluginId: "org.cslblog.classsync"
    title: qsTr("课表同步")

    property bool paired: false
    property string deviceName: ""
    property string lastSyncTime: ""
    property string lastError: ""
    property string lastMessage: ""
    property string modeInfo: ""
    property bool portable: false
    property int scheduleRevision: 0
    property string pendingInfo: ""
    property string pendingInstall: ""
    property string syncState: "ready"
    property string syncMessage: qsTr("就绪")

    Component.onCompleted: refreshState()

    Connections {
        target: backend
        function onConfigChanged() { refreshState() }
        function onSyncStatusChanged(status, message) {
            syncState = status
            syncMessage = message
        }
        function onPairResult(success, message) {
            if (success) {
                floatLayer.createInfoBar({
                    title: qsTr("配对成功"),
                    text: message,
                    severity: Severity.Success,
                    timeout: 4000,
                })
            } else {
                floatLayer.createInfoBar({
                    title: qsTr("配对失败"),
                    text: message,
                    severity: Severity.Error,
                    timeout: 6000,
                })
            }
            refreshState()
        }
    }

    function refreshState() {
        if (!backend) return
        paired = backend.isPaired()
        deviceName = backend.getDeviceName()
        lastSyncTime = backend.getLastSyncTime()
        lastError = backend.getLastError()
        lastMessage = backend.getLastMessage()
        modeInfo = backend.getModeInfo()
        pendingInstall = backend.getPendingInstall()
        portable = backend.isPortable()
        scheduleRevision = backend.getScheduleRevision()
        pendingInfo = backend.getPendingInfo()
        if (!paired && !serverUrlField.text) {
            const saved = backend.getServerUrl()
            if (saved) serverUrlField.text = saved
        }
    }

    ColumnLayout {
        Layout.fillWidth: true
        spacing: 12

        // ---------------------------------------------------------- 连接
        Text {
            text: qsTr("连接")
            typography: Typography.BodyStrong
        }

        SettingCard {
            Layout.fillWidth: true
            icon.name: paired ? "ic_fluent_cloud_checkmark_20_regular" : "ic_fluent_cloud_dismiss_20_regular"
            title: paired ? qsTr("已绑定到课表同步服务") : qsTr("未绑定")
            description: paired
                ? qsTr("设备：%1\n状态：%2").arg(deviceName.length ? deviceName : qsTr("未命名")).arg(syncMessage)
                : qsTr("填入服务器地址和后台生成的一次性配对码")

            RowLayout {
                spacing: 8
                Button {
                    visible: paired
                    icon.name: "ic_fluent_arrow_sync_20_regular"
                    text: qsTr("立即同步")
                    enabled: syncState !== "syncing"
                    onClicked: backend.doSync()
                }
                Button {
                    visible: paired
                    icon.name: "ic_fluent_plug_disconnected_20_regular"
                    text: qsTr("解除绑定")
                    enabled: syncState !== "syncing"
                    onClicked: backend.doUnpair()
                }
            }
        }

        ColumnLayout {
            Layout.fillWidth: true
            visible: !paired
            spacing: 8

            SettingItem {
                Layout.fillWidth: true
                title: qsTr("服务器地址")
                description: qsTr("例如 https://classsync.cslblog.dpdns.org")
                TextField {
                    id: serverUrlField
                    Layout.preferredWidth: 320
                    placeholderText: "https://classsync.cslblog.dpdns.org"
                }
            }

            SettingItem {
                Layout.fillWidth: true
                title: qsTr("设备名称")
                description: qsTr("例如：高一（1）班")
                TextField {
                    id: deviceNameField
                    Layout.preferredWidth: 320
                }
            }

            SettingItem {
                Layout.fillWidth: true
                title: qsTr("一次性配对码")
                description: qsTr("在后台点「生成配对码」获取")
                TextField {
                    id: pairingCodeField
                    Layout.preferredWidth: 240
                    maximumLength: 32
                    onTextChanged: {
                        const upper = text.toUpperCase()
                        if (upper !== text) text = upper
                    }
                }
            }

            Button {
                Layout.alignment: Qt.AlignRight
                icon.name: "ic_fluent_plug_connected_20_regular"
                text: qsTr("绑定")
                enabled: serverUrlField.text.length > 0
                    && pairingCodeField.text.length >= 4
                    && syncState !== "syncing"
                onClicked: backend.doPair(
                    serverUrlField.text.trim(),
                    pairingCodeField.text.trim(),
                    deviceNameField.text.trim()
                )
            }
        }

        // ---------------------------------------------------------- 同步状态
        Text {
            visible: paired
            text: qsTr("同步状态")
            typography: Typography.BodyStrong
        }

        SettingCard {
            visible: paired
            Layout.fillWidth: true
            icon.name: "ic_fluent_history_20_regular"
            title: lastSyncTime.length > 0 ? qsTr("最近同步 %1").arg(lastSyncTime) : qsTr("尚未完成同步")
            description: {
                var lines = []
                if (pendingInfo.length > 0) lines.push(pendingInfo)
                lines.push(qsTr("课表版本 v%1").arg(scheduleRevision))
                lines.push(qsTr("当前模式：%1").arg(portable ? qsTr("便携版") : qsTr("用户目录")))
                if (lastError.length > 0) lines.push(qsTr("错误：") + lastError)
                else if (lastMessage.length > 0) lines.push(lastMessage)
                return lines.join("\n")
            }
        }

        // ---------------------------------------------------------- 远程安装（后台只能把包搬过来，生效必须在本机点这里同意）
        Text {
            text: qsTr("远程安装")
            typography: Typography.BodyStrong
        }

        SettingCard {
            Layout.fillWidth: true
            icon.name: pendingInstall.length > 0
                ? "ic_fluent_arrow_download_20_regular"
                : "ic_fluent_shield_checkmark_20_regular"
            title: pendingInstall.length > 0
                ? qsTr("已下载待安装：") + pendingInstall
                : qsTr("没有待安装的插件")
            description: pendingInstall.length > 0
                ? qsTr("后台已下载并校验过这个包，但它不会自己生效。点右边「安装」才会真正装进插件目录，装完需要重启。")
                : qsTr("后台推送插件包后，会先下载校验再出现在这里，必须由你在这台机器上点「安装」才生效。")

            RowLayout {
                spacing: 8

                Button {
                    visible: pendingInstall.length > 0
                    icon.name: "ic_fluent_checkmark_circle_20_regular"
                    text: qsTr("安装")
                    enabled: syncState !== "syncing"
                    onClicked: {
                        const msg = backend.doInstallPending()
                        const good = msg.indexOf(qsTr("已安装")) >= 0
                        floatLayer.createInfoBar({
                            title: qsTr("安装插件"),
                            text: msg,
                            severity: good ? Severity.Success : Severity.Warning,
                            timeout: good ? 9000 : 6000,
                        })
                        refreshState()
                    }
                }

                Button {
                    visible: pendingInstall.length > 0
                    icon.name: "ic_fluent_delete_20_regular"
                    text: qsTr("放弃")
                    enabled: syncState !== "syncing"
                    onClicked: {
                        const msg = backend.doDiscardPending()
                        floatLayer.createInfoBar({
                            title: qsTr("放弃安装"),
                            text: msg,
                            severity: Severity.Info,
                            timeout: 5000,
                        })
                        refreshState()
                    }
                }

                Button {
                    icon.name: "ic_fluent_arrow_sync_20_regular"
                    text: qsTr("立即检查")
                    enabled: paired && syncState !== "syncing"
                    onClicked: backend.doSync()
                }
            }
        }

        // ---------------------------------------------------------- 数据目录 / 便携版
        Text {
            text: qsTr("数据目录")
            typography: Typography.BodyStrong
        }

        SettingCard {
            Layout.fillWidth: true
            icon.name: portable ? "ic_fluent_hard_drive_20_regular" : "ic_fluent_folder_20_regular"
            title: portable ? qsTr("便携版（数据在程序目录）") : qsTr("用户目录（数据在 C 盘）")
            description: modeInfo + "\n" + qsTr("冰点还原的电脑请切到便携版，把数据放到 D 盘。")

            Button {
                visible: !portable
                icon.name: "ic_fluent_arrow_move_20_regular"
                text: qsTr("切换到便携版")
                enabled: syncState !== "syncing"
                onClicked: {
                    const msg = backend.doSwitchToPortable()
                    floatLayer.createInfoBar({
                        title: qsTr("切换便携版"),
                        text: msg,
                        severity: msg.indexOf(qsTr("已切换到便携版")) >= 0 ? Severity.Success : Severity.Warning,
                        timeout: msg.indexOf(qsTr("已切换到便携版")) >= 0 ? 8000 : 6000,
                    })
                    refreshState()
                }
            }

            Button {
                visible: portable
                icon.name: "ic_fluent_arrow_undo_20_regular"
                text: qsTr("切回用户目录")
                onClicked: {
                    const msg = backend.doSwitchBackToUserDir()
                    floatLayer.createInfoBar({
                        title: qsTr("切回用户目录"),
                        text: msg,
                        severity: Severity.Info,
                        timeout: 8000,
                    })
                    refreshState()
                }
            }

            Button {
                icon.name: "ic_fluent_arrow_clockwise_20_regular"
                text: qsTr("重启 Class Widgets")
                onClicked: backend.doRestartApp()
            }
        }
    }
}
