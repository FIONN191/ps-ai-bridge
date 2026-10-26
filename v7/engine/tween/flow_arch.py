"""
Frame blend architecture.

Pure PyTorch. No external framework dependency: the device probe is local
(see _target_device below), and every tensor operation is plain torch.
"""
from torch.nn.parallel import DistributedDataParallel as DDP
from torch.optim import AdamW
import torch
import torch.nn.functional as F
import torch.nn as nn
import torch.optim as optim
import warnings




def _target_device():
    """本机可用计算设备。没有显卡就退 CPU（慢但不会崩）。"""
    if torch.cuda.is_available():
        return torch.device("cuda")
    return torch.device("cpu")


device = _target_device()
grid_cache = {}


class SkipConv(nn.Module):
    def __init__(self, c, dilation=1):
        super(SkipConv, self).__init__()
        self.conv = nn.Conv2d(c, c, 3, 1, dilation, dilation=dilation, groups=1)
        self.beta = nn.Parameter(torch.ones((1, c, 1, 1)), requires_grad=True)
        self.relu = nn.LeakyReLU(0.2, True)

    def forward(self, x):
        return self.relu(self.conv(x) * self.beta + x)


def shift(src, vec):
    k = (str(vec.device), str(vec.size()))
    if k not in grid_cache:
        grid_x = (
            torch.linspace(-1.0, 1.0, vec.shape[3], device=device)
            .view(1, 1, 1, vec.shape[3])
            .expand(vec.shape[0], -1, vec.shape[2], -1)
        )
        grid_y = (
            torch.linspace(-1.0, 1.0, vec.shape[2], device=device)
            .view(1, 1, vec.shape[2], 1)
            .expand(vec.shape[0], -1, -1, vec.shape[3])
        )
        grid_cache[k] = torch.cat([grid_x, grid_y], 1).to(device)

    vec = torch.cat(
        [
            vec[:, 0:1, :, :] / ((src.shape[3] - 1.0) / 2.0),
            vec[:, 1:2, :, :] / ((src.shape[2] - 1.0) / 2.0),
        ],
        1,
    )

    g = (grid_cache[k] + vec).permute(0, 2, 3, 1)

    if g.dtype != src.dtype:
        g = g.to(src.dtype)

    padding_mode = "border"
    if device.type == "mps":
        # https://github.com/pytorch/pytorch/issues/125098
        padding_mode = "zeros"
        g = g.clamp(-1, 1)
    return torch.nn.functional.grid_sample(
        input=src,
        grid=g,
        mode="bilinear",
        padding_mode=padding_mode,
        align_corners=True,
    )


def conv(
    in_planes,
    out_planes,
    kernel_size=3,
    stride=1,
    padding=1,
    dilation=1,
    layout="d1",
):
    if layout == "d1":
        return nn.Sequential(
            nn.Conv2d(
                in_planes,
                out_planes,
                kernel_size=kernel_size,
                stride=stride,
                padding=padding,
                dilation=dilation,
                bias=True,
            ),
            nn.PReLU(out_planes),
        )
    if layout in ["d2", "d3", "d5", "d6", "d7", "d10", "d17", "d26"]:
        return nn.Sequential(
            nn.Conv2d(
                in_planes,
                out_planes,
                kernel_size=kernel_size,
                stride=stride,
                padding=padding,
                dilation=dilation,
                bias=True,
            ),
            nn.LeakyReLU(0.2, True),
        )


def conv_plain(in_planes, out_planes, kernel_size=3, stride=1, padding=1, dilation=1):
    return nn.Sequential(
        nn.Conv2d(
            in_planes,
            out_planes,
            kernel_size=kernel_size,
            stride=stride,
            padding=padding,
            dilation=dilation,
            bias=True,
        ),
    )


def conv_plain(in_planes, out_planes, kernel_size=3, stride=1, padding=1, dilation=1):
    return nn.Sequential(
        nn.Conv2d(
            in_planes,
            out_planes,
            kernel_size=kernel_size,
            stride=stride,
            padding=padding,
            dilation=dilation,
            bias=True,
        )
    )


def upconv(in_planes, out_planes, kernel_size=4, stride=2, padding=1, layout="d1"):
    if layout == "d1":
        return nn.Sequential(
            torch.nn.ConvTranspose2d(
                in_channels=in_planes,
                out_channels=out_planes,
                kernel_size=4,
                stride=2,
                padding=1,
                bias=True,
            ),
            nn.PReLU(out_planes),
        )
    if layout in ["d2", "d3", "d5", "d6", "d7", "d10", "d17", "d26"]:
        return nn.Sequential(
            torch.nn.ConvTranspose2d(
                in_channels=in_planes,
                out_channels=out_planes,
                kernel_size=4,
                stride=2,
                padding=1,
                bias=True,
            ),
            nn.LeakyReLU(0.2, True),
        )


class DownBlock(nn.Module):
    def __init__(self, in_planes, out_planes, stride=2, layout="d1"):
        super(DownBlock, self).__init__()
        self.conv1 = conv(in_planes, out_planes, 3, stride, 1, layout=layout)
        self.conv2 = conv(out_planes, out_planes, 3, 1, 1, layout=layout)

    def forward(self, x):
        x = self.conv1(x)
        x = self.conv2(x)
        return x


class FlowStage(nn.Module):
    def __init__(self, in_planes, c=64, layout="d1"):
        super(FlowStage, self).__init__()
        self.layout = layout
        self.pre = nn.Sequential(
            conv(in_planes, c // 2, 3, 2, 1, layout=layout),
            conv(c // 2, c, 3, 2, 1, layout=layout),
        )
        self.layout = layout

        if layout in ["d1", "d2", "d3"]:
            self.body = nn.Sequential(
                conv(c, c, layout=layout),
                conv(c, c, layout=layout),
                conv(c, c, layout=layout),
                conv(c, c, layout=layout),
                conv(c, c, layout=layout),
                conv(c, c, layout=layout),
                conv(c, c, layout=layout),
                conv(c, c, layout=layout),
            )
            self.post = nn.ConvTranspose2d(c, 5, 4, 2, 1)

        if layout in ["d5", "d6", "d7", "d10", "d17"]:
            self.body = nn.Sequential(
                SkipConv(c),
                SkipConv(c),
                SkipConv(c),
                SkipConv(c),
                SkipConv(c),
                SkipConv(c),
                SkipConv(c),
                SkipConv(c),
            )
        if layout == "d5":
            self.post = nn.Sequential(
                nn.ConvTranspose2d(c, 4 * 5, 4, 2, 1), nn.PixelShuffle(2)
            )
        if layout in ["d6", "d7", "d10", "d17"]:
            self.post = nn.Sequential(
                nn.ConvTranspose2d(c, 4 * 6, 4, 2, 1), nn.PixelShuffle(2)
            )

         # 变体支持
        if layout in ["d26"]:
            self.body = nn.Sequential(
                SkipConv(c),
                SkipConv(c),
                SkipConv(c),
                SkipConv(c),
                SkipConv(c),
                SkipConv(c),
                SkipConv(c),
                SkipConv(c),
            )
            self.post = nn.Sequential(
                nn.ConvTranspose2d(c, 4*13, 4, 2, 1),
                nn.PixelShuffle(2)
            )

    def forward(self, x, flow=None, scale=1):
        x = F.interpolate(
            x, scale_factor=1.0 / scale, mode="bilinear", align_corners=False
        )
        if flow is not None:
            flow = (
                F.interpolate(
                    flow, scale_factor=1.0 / scale, mode="bilinear", align_corners=False
                )
                * 1.0
                / scale
            )
            x = torch.cat((x, flow), 1)
        feat = self.pre(x)
        if self.layout == "d1":
            feat = self.body(feat) + feat
        if self.layout in ["d2", "d3", "d5", "d6", "d7", "d10", "d17", "d26"]:
            feat = self.body(feat)

        tmp = self.post(feat)
        if self.layout in ["d1", "d2", "d3"]:
            tmp = F.interpolate(
                tmp, scale_factor=scale * 2, mode="bilinear", align_corners=False
            )
            flow = tmp[:, :4] * scale * 2
        if self.layout in ["d5", "d6", "d7", "d10", "d17"]:
            tmp = F.interpolate(
                tmp, scale_factor=scale, mode="bilinear", align_corners=False
            )
            flow = tmp[:, :4] * scale
        if self.layout in ["d26"]:
            tmp = F.interpolate(
                tmp, scale_factor=scale, mode="bilinear", align_corners=False
            )
            flow = tmp[:, :4] * scale
            mask = tmp[:, 4:5]
            feat_out = tmp[:, 5:]
            return flow, mask, feat_out
        mask = tmp[:, 4:5]
        return flow, mask


class AuxNet(nn.Module):
    def __init__(self, layout="d1"):
        super(AuxNet, self).__init__()
        c = 16
        self.conv1 = DownBlock(3, c, layout=layout)
        self.conv2 = DownBlock(c, 2 * c, layout=layout)
        self.conv3 = DownBlock(2 * c, 4 * c, layout=layout)
        self.conv4 = DownBlock(4 * c, 8 * c, layout=layout)

    def forward(self, x, flow):
        x = self.conv1(x)
        flow = (
            F.interpolate(flow, scale_factor=0.5, mode="bilinear", align_corners=False)
            * 0.5
        )
        f1 = shift(x, flow)
        x = self.conv2(x)
        flow = (
            F.interpolate(flow, scale_factor=0.5, mode="bilinear", align_corners=False)
            * 0.5
        )
        f2 = shift(x, flow)
        x = self.conv3(x)
        flow = (
            F.interpolate(flow, scale_factor=0.5, mode="bilinear", align_corners=False)
            * 0.5
        )
        f3 = shift(x, flow)
        x = self.conv4(x)
        flow = (
            F.interpolate(flow, scale_factor=0.5, mode="bilinear", align_corners=False)
            * 0.5
        )
        f4 = shift(x, flow)
        return [f1, f2, f3, f4]


class FuseNet(nn.Module):
    def __init__(self, layout="d1"):
        super(FuseNet, self).__init__()
        c = 16
        self.enc0 = DownBlock(17, 2 * c, layout=layout)
        self.enc1 = DownBlock(4 * c, 4 * c, layout=layout)
        self.enc2 = DownBlock(8 * c, 8 * c, layout=layout)
        self.enc3 = DownBlock(16 * c, 16 * c, layout=layout)
        self.dec0 = upconv(32 * c, 8 * c, layout=layout)
        self.dec1 = upconv(16 * c, 4 * c, layout=layout)
        self.dec2 = upconv(8 * c, 2 * c, layout=layout)
        self.dec3 = upconv(4 * c, c, layout=layout)
        self.conv = nn.Conv2d(c, 3, 3, 1, 1)

    def forward(self, img0, img1, warped_img0, warped_img1, mask, flow, c0, c1):
        s0 = self.enc0(
            torch.cat((img0, img1, warped_img0, warped_img1, mask, flow), 1)
        )
        s1 = self.enc1(torch.cat((s0, c0[0], c1[0]), 1))
        s2 = self.enc2(torch.cat((s1, c0[1], c1[1]), 1))
        s3 = self.enc3(torch.cat((s2, c0[2], c1[2]), 1))
        x = self.dec0(torch.cat((s3, c0[3], c1[3]), 1))
        x = self.dec1(torch.cat((x, s2), 1))
        x = self.dec2(torch.cat((x, s1), 1))
        x = self.dec3(torch.cat((x, s0), 1))
        x = self.conv(x)
        return torch.sigmoid(x)


"""Layout variants supported by this file."""
class HeadV2(nn.Module):
    def __init__(self):
        super(HeadV2, self).__init__()
        self.pj0 = nn.Conv2d(3, 32, 3, 2, 1)
        self.pj1 = nn.Conv2d(32, 32, 3, 1, 1)
        self.pj2 = nn.Conv2d(32, 32, 3, 1, 1)
        self.pj3 = nn.ConvTranspose2d(32, 8, 4, 2, 1)
        self.relu = nn.LeakyReLU(0.2, True)

    def forward(self, x, feat=False):
        x0 = self.pj0(x)
        x = self.relu(x0)
        x1 = self.pj1(x)
        x = self.relu(x1)
        x2 = self.pj2(x)
        x = self.relu(x2)
        x3 = self.pj3(x)
        if feat:
            return [x0, x1, x2, x3]
        return x3


class Head(nn.Module):
    def __init__(self):
        super(Head, self).__init__()
        self.pj0 = nn.Conv2d(3, 16, 3, 2, 1)
        self.pj1 = nn.Conv2d(16, 16, 3, 1, 1)
        self.pj2 = nn.Conv2d(16, 16, 3, 1, 1)
        self.pj3 = nn.ConvTranspose2d(16, 4, 4, 2, 1)
        self.relu = nn.LeakyReLU(0.2, True)

    def forward(self, x, feat=False):
        x0 = self.pj0(x)
        x = self.relu(x0)
        x1 = self.pj1(x)
        x = self.relu(x1)
        x2 = self.pj2(x)
        x = self.relu(x2)
        x3 = self.pj3(x)
        if feat:
            return [x0, x1, x2, x3]
        return x3


class FlowNet(nn.Module):
    def __init__(self, layout="d1"):
        super(FlowNet, self).__init__()
        self.layout = layout
        if layout in ["d1", "d2", "d3", "d5", "d6"]:
            self.stage0 = FlowStage(7, c=192, layout=layout)
            self.stage1 = FlowStage(8 + 4, c=128, layout=layout)
            self.stage2 = FlowStage(8 + 4, c=96, layout=layout)
            self.stage3 = FlowStage(8 + 4, c=64, layout=layout)
        if layout in ["d7"]:
            self.stage0 = FlowStage(7 + 8, c=192, layout=layout)
            self.stage1 = FlowStage(8 + 4 + 8, c=128, layout=layout)
            self.stage2 = FlowStage(8 + 4 + 8, c=96, layout=layout)
            self.stage3 = FlowStage(8 + 4 + 8, c=64, layout=layout)
            self.proj = nn.Sequential(
                nn.Conv2d(3, 16, 3, 2, 1), nn.ConvTranspose2d(16, 4, 4, 2, 1)
            )
        if layout in ["d10", "d17"]:
            self.stage0 = FlowStage(7 + 16, c=192, layout=layout)
            self.stage1 = FlowStage(8 + 4 + 16, c=128, layout=layout)
            self.stage2 = FlowStage(8 + 4 + 16, c=96, layout=layout)
            self.stage3 = FlowStage(8 + 4 + 16, c=64, layout=layout)
            if layout == "d10":
                self.proj = nn.Sequential(
                    nn.Conv2d(3, 32, 3, 2, 1),
                    nn.LeakyReLU(0.2, True),
                    nn.Conv2d(32, 32, 3, 1, 1),
                    nn.LeakyReLU(0.2, True),
                    nn.Conv2d(32, 32, 3, 1, 1),
                    nn.LeakyReLU(0.2, True),
                    nn.ConvTranspose2d(32, 8, 4, 2, 1),
                )
            else:
                self.proj = HeadV2()
                
        if layout in ["legacy"]:
            self.stage0 = FlowStage(7 + 16, c=192)
            self.stage1 = FlowStage(8 + 4 + 16, c=128)
            self.stage2 = FlowStage(8 + 4 + 16, c=96)
            self.stage3 = FlowStage(8 + 4 + 16, c=64)
            self.proj = nn.Sequential(
                nn.Conv2d(3, 32, 3, 2, 1),
                nn.LeakyReLU(0.2, True),
                nn.Conv2d(32, 32, 3, 1, 1),
                nn.LeakyReLU(0.2, True),
                nn.Conv2d(32, 32, 3, 1, 1),
                nn.LeakyReLU(0.2, True),
                nn.ConvTranspose2d(32, 8, 4, 2, 1),
            )

        # 变体支持
        if layout in ["d26"]:
            self.stage0 = FlowStage(7+8, c=192, layout=layout)  
            self.stage1 = FlowStage(8+4+8+8, c=128, layout=layout)  
            self.stage2 = FlowStage(8+4+8+8, c=96, layout=layout)
            self.stage3 = FlowStage(8+4+8+8, c=64, layout=layout)
            self.stage4 = FlowStage(8+4+8+8, c=32, layout=layout) 
            self.proj = Head() 
            
        
        if layout in ["d1", "d2", "d3"]:
            self.aux = AuxNet(layout=layout)
            self.fuse = FuseNet(layout=layout)
        self.layout = layout

    def forward(
        self,
        img0,
        img1,
        timestep=0.5,
        scale_list=[16, 8, 4, 2, 1],
        training=True,
        fastmode=True,
        ensemble=False,
        return_flow=False,
    ):
        img0 = torch.clamp(img0, 0, 1)
        img1 = torch.clamp(img1, 0, 1)

        n, c, h, w = img0.shape
        ph = ((h - 1) // 64 + 1) * 64
        pw = ((w - 1) // 64 + 1) * 64
        padding = (0, pw - w, 0, ph - h)
        img0 = F.pad(img0, padding)
        img1 = F.pad(img1, padding)
        x = torch.cat((img0, img1), 1)

        if training == False:
            channel = x.shape[1] // 2
            img0 = x[:, :channel]
            img1 = x[:, channel:]
        if not torch.is_tensor(timestep):
            timestep = (x[:, :1].clone() * 0 + 1) * timestep
        else:
            timestep = timestep.repeat(1, 1, img0.shape[2], img0.shape[3])

        flow_list = []
        merged = []
        mask_list = []

        # 变体支持
        if self.layout in ["d7", "d10", "d17", "d26"]:
            f0 = self.proj(img0[:, :3])
            f1 = self.proj(img1[:, :3])

        warped_img0 = img0
        warped_img1 = img1
        flow = None
        mask = None
        feat = None 
        
        # 变体支持
        if self.layout in ["d26"]:
            block = [self.stage0, self.stage1, self.stage2, self.stage3, self.stage4]
            num_blocks = 5
        else:
            block = [self.stage0, self.stage1, self.stage2, self.stage3]
            num_blocks = 4

        for i in range(num_blocks):
            if flow is None:
                if self.layout in ["d26"]:
                    flow, mask, feat = block[i](
                        torch.cat((img0[:, :3], img1[:, :3], f0, f1, timestep), 1),
                        None,
                        scale=scale_list[i],
                    )
                elif self.layout in ["d1", "d2", "d3", "d5", "d6"]:
                    flow, mask = block[i](
                        torch.cat((img0[:, :3], img1[:, :3], timestep), 1),
                        None,
                        scale=scale_list[i],
                    )
                    if ensemble:
                        f1, m1 = block[i](
                            torch.cat((img1[:, :3], img0[:, :3], 1 - timestep), 1),
                            None,
                            scale=scale_list[i],
                        )
                        flow = (flow + torch.cat((f1[:, 2:4], f1[:, :2]), 1)) / 2
                        mask = (mask + (-m1)) / 2

                # 变体
                if self.layout in ["d7", "d10", "d17"]:
                    flow, mask = block[i](
                        torch.cat((img0[:, :3], img1[:, :3], f0, f1, timestep), 1),
                        None,
                        scale=scale_list[i],
                    )

                    if ensemble:
                        f_, m_ = block[i](
                            torch.cat(
                                (img1[:, :3], img0[:, :3], f1, f0, 1 - timestep), 1
                            ),
                            None,
                            scale=scale_list[i],
                        )
                        flow = (flow + torch.cat((f_[:, 2:4], f_[:, :2]), 1)) / 2
                        mask = (mask + (-m_)) / 2

            else:
                # 变体支持
                if self.layout in ["d26"]:
                    wf0 = shift(f0, flow[:, :2])
                    wf1 = shift(f1, flow[:, 2:4])
                    
                    # 变体支持
                    input_tensor = torch.cat(
                        (
                            warped_img0[:, :3],
                            warped_img1[:, :3],
                            wf0,
                            wf1,
                            timestep,
                            mask,
                            feat,  
                        ),
                        1,
                    )
                    
                    fd, m0, feat = block[i](
                        input_tensor,
                        flow,
                        scale=scale_list[i],
                    )
                    flow = flow + fd
                    mask = m0
                # 变体-v
                elif self.layout in ["d1", "d2", "d3", "d5", "d6"]:
                    f0, m0 = block[i](
                        torch.cat(
                            (warped_img0[:, :3], warped_img1[:, :3], timestep, mask), 1
                        ),
                        flow,
                        scale=scale_list[i],
                    )

                if self.layout in ["d1"]:
                    if (
                        i == 1
                        and f0[:, :2].abs().max() > 32
                        and f0[:, 2:4].abs().max() > 32
                        and not training
                    ):
                        for k in range(4):
                            scale_list[k] *= 2
                        flow, mask = block[0](
                            torch.cat((img0[:, :3], img1[:, :3], timestep), 1),
                            None,
                            scale=scale_list[0],
                        )
                        warped_img0 = shift(img0, flow[:, :2])
                        warped_img1 = shift(img1, flow[:, 2:4])
                        f0, m0 = block[i](
                            torch.cat(
                                (
                                    warped_img0[:, :3],
                                    warped_img1[:, :3],
                                    timestep,
                                    mask,
                                ),
                                1,
                            ),
                            flow,
                            scale=scale_list[i],
                        )

                # 变体
                if self.layout in ["d7", "d10", "d17"]:
                    fd, m0 = block[i](
                        torch.cat(
                            (
                                warped_img0[:, :3],
                                warped_img1[:, :3],
                                shift(f0, flow[:, :2]),
                                shift(f1, flow[:, 2:4]),
                                timestep,
                                mask,
                            ),
                            1,
                        ),
                        flow,
                        scale=scale_list[i],
                    )
                    flow = flow + fd

                # 变体-v ensemble
                if ensemble and self.layout in [
                    "d1",
                    "d2",
                    "d3",
                    "d5",
                    "d6",
                ]:
                    f1, m1 = block[i](
                        torch.cat(
                            (
                                warped_img1[:, :3],
                                warped_img0[:, :3],
                                1 - timestep,
                                -mask,
                            ),
                            1,
                        ),
                        torch.cat((flow[:, 2:4], flow[:, :2]), 1),
                        scale=scale_list[i],
                    )
                    f0 = (f0 + torch.cat((f1[:, 2:4], f1[:, :2]), 1)) / 2
                    m0 = (m0 + (-m1)) / 2

                # 变体 ensemble
                if ensemble and self.layout in ["d7", "d10", "d17"]:
                    wf0 = shift(f0, flow[:, :2])
                    wf1 = shift(f1, flow[:, 2:4])

                    f_, m_ = block[i](
                        torch.cat(
                            (
                                warped_img1[:, :3],
                                warped_img0[:, :3],
                                wf1,
                                wf0,
                                1 - timestep,
                                -mask,
                            ),
                            1,
                        ),
                        torch.cat((flow[:, 2:4], flow[:, :2]), 1),
                        scale=scale_list[i],
                    )
                    fd = (fd + torch.cat((f_[:, 2:4], f_[:, :2]), 1)) / 2
                    mask = (m0 + (-m_)) / 2

                if self.layout in ["d1", "d2", "d3", "d5", "d6"]:
                    flow = flow + f0
                    mask = mask + m0

                if not ensemble and self.layout in ["d7", "d10", "d17"]:
                    mask = m0

            mask_list.append(mask)
            flow_list.append(flow)
            warped_img0 = shift(img0, flow[:, :2])
            warped_img1 = shift(img1, flow[:, 2:4])
            merged.append((warped_img0, warped_img1))

        # 变体支持
        if self.layout in ["d26"]:
            final_mask = mask_list[-1] if mask_list else mask
            final_mask = torch.sigmoid(final_mask)
            merged_final = warped_img0 * final_mask + warped_img1 * (1 - final_mask)
        else:
            if self.layout in ["d1", "d2", "d3", "d5", "d6"]:
                final_idx = min(3, len(mask_list)-1) if len(mask_list) > 0 else 0
                if final_idx < len(mask_list):
                    mask_list[final_idx] = torch.sigmoid(mask_list[final_idx])
                    merged_final = merged[final_idx][0] * mask_list[final_idx] + merged[final_idx][1] * (1 - mask_list[final_idx])
                else:
                    mask = torch.sigmoid(mask)
                    merged_final = warped_img0 * mask + warped_img1 * (1 - mask)
            if self.layout in ["d7", "d10", "d17"]:
                mask = torch.sigmoid(mask)
                merged_final = warped_img0 * mask + warped_img1 * (1 - mask)

        if not fastmode and self.layout in ["d1", "d2", "d3"]:
            c0 = self.aux(img0, flow[:, :2])
            c1 = self.aux(img1, flow[:, 2:4])
            tmp = self.fuse(img0, img1, warped_img0, warped_img1, mask, flow, c0, c1)
            res = tmp[:, :3] * 2 - 1
            merged_final = torch.clamp(merged_final + res, 0, 1)
        
        return merged_final[:, :, :h, :w]  